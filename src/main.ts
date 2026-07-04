/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './polyfill.js';

import process from 'node:process';

import {parseArguments} from './cli.js';
import {NOTICE_TITLES} from './flows/flow-messaging.js';
import {FlowController, type FlowOpParams} from './flows/FlowController.js';
import {FlowService} from './flows/FlowService.js';
import {IdleReaper} from './IdleReaper.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger, saveLogsToFile} from './logger.js';
import {McpResponse} from './McpResponse.js';
import {textResult, errorResult} from './McpResult.js';
import {MultiTabToolGate} from './MultiTabToolGate.js';
import {extractOwner, OWNER_PARAM} from './owner.js';
import {SessionManager} from './SessionManager.js';
import {SessionRegistry} from './SessionRegistry.js';
import {SessionService} from './SessionService.js';
import {
  McpServer,
  StdioServerTransport,
  type CallToolResult,
  SetLevelRequestSchema,
  zod,
} from './third_party/index.js';
import {ToolCategory} from './tools/categories.js';
import type {ToolDefinition} from './tools/ToolDefinition.js';
import {tools, sessionToolNames} from './tools/tools.js';

const VERSION = '0.16.0';

export const args = parseArguments(VERSION);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;
if (
  process.env['CI'] ||
  process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS']
) {
  console.error(
    "turning off usage statistics. process.env['CI'] || process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS'] is set.",
  );
  args.usageStatistics = false;
}

void logFile;

process.on('unhandledRejection', (reason, promise) => {
  logger('Unhandled promise rejection', promise, reason);
});

// A synchronous throw in a stray event listener (browser 'disconnected',
// dialog handler, etc.) must never crash the whole server and take every
// other session down with it. Log and keep serving.
process.on('uncaughtException', (err, origin) => {
  logger(`Uncaught exception (${origin}), continuing:`, err);
});

logger(`Starting Chrome DevTools MCP Server v${VERSION}`);
const server = new McpServer(
  {
    name: 'chrome_devtools',
    title: 'Chrome DevTools MCP server (multi-session)',
    version: VERSION,
  },
  {capabilities: {logging: {}}},
);
server.server.setRequestHandler(SetLevelRequestSchema, () => {
  return {};
});

const devtools = args.experimentalDevtools ?? false;
const persistSessions = args.persistSessions ?? false;
const sessionRegistry = persistSessions ? new SessionRegistry() : undefined;

// Idle windows (single source of truth). `tabIdleMs` is shared by the model
// notice ("tab idle N min") and the reaper so they never disagree; a whole
// session's browser is only closed after the longer `sessionIdleMs`.
const tabIdleMs = Math.max(0, (args.tabIdleMinutes ?? 15) * 60_000);
const sessionIdleMs = Math.max(0, (args.sessionIdleMinutes ?? 30) * 60_000);

const sessionManager = new SessionManager(
  {
    experimentalDevToolsDebugging: devtools,
    experimentalIncludeAllPages: args.experimentalIncludeAllPages,
    performanceCrux: args.performanceCrux,
    // Propagate the configured tab-idle threshold so notices and reaping share
    // one value. Infinity when disabled (no reaping, notice effectively off).
    tabIdleTimeoutMs: tabIdleMs > 0 ? tabIdleMs : Number.POSITIVE_INFINITY,
  },
  {registry: sessionRegistry, detached: persistSessions},
);

// Reclaim resources for idle work WITHOUT killing active sessions: close idle
// background tabs first (cheap), then close whole sessions only after a longer
// full-idle window. Replaces the host broker's blunt kill-the-subprocess
// behavior that took every session down at once.
const idleReaper =
  tabIdleMs > 0 || sessionIdleMs > 0
    ? new IdleReaper(sessionManager, {
        // A 0 flag disables that tier by pushing its threshold to Infinity.
        tabIdleMs: tabIdleMs > 0 ? tabIdleMs : Number.POSITIVE_INFINITY,
        sessionIdleMs:
          sessionIdleMs > 0 ? sessionIdleMs : Number.POSITIVE_INFINITY,
      })
    : undefined;

const sessionService = new SessionService(
  sessionManager,
  {
    channel: args.channel as 'stable' | 'canary' | 'beta' | 'dev' | undefined,
    executablePath: args.executablePath,
    chromeArgs: (args.chromeArg ?? []).map(String),
    ignoreDefaultChromeArgs: (args.ignoreDefaultChromeArg ?? []).map(String),
    acceptInsecureCerts: args.acceptInsecureCerts,
    devtools,
    enableExtensions: args.categoryExtensions,
  },
  {persist: persistSessions},
);

// switch_tab and other tab-targeting tools become visible on demand once a
// session has multiple tabs. The gate owns that transition and its emitted
// notifications/tools/list_changed.
const multiTabGate = new MultiTabToolGate();
function syncMultiTabTools(): void {
  multiTabGate.sync(
    sessionManager.listSessionInfos().map(session => session.context),
  );
}

// Experimental flow recorder/replayer. When enabled, every successful mutating
// browser action is buffered per session, and the `flow` tool is exposed to
// save/list/validate/replay reusable .cdp.ts flows.
const flowsEnabled = args.experimentalFlows ?? false;
const flowService = flowsEnabled
  ? new FlowService({
      projectRoot: args.flowsProjectRoot ?? process.cwd(),
      tools,
    })
  : undefined;

// Renders the op-based `flow` tool. exec runs against a session under its
// mutex; resolution + locking stay in the transport (this module) so the
// controller is decoupled from SessionManager.
const flowController = flowService
  ? new FlowController(
      flowService,
      async (sessionId, owner, run) => {
        const session = sessionManager.getSession(sessionId, owner);
        const guard = await session.mutex.acquire();
        try {
          return await run(session.context);
        } finally {
          guard.dispose();
        }
      },
      // Ownership guard: getSession throws the generic "not found" for a
      // foreign/unknown session, which is exactly the isolation semantics we
      // want for recorder-touching ops (draft/save) too.
      (sessionId, owner) => {
        sessionManager.getSession(sessionId, owner);
      },
    )
  : undefined;

/**
 * Appends a titled notice block to a tool response's text content (single
 * helper for every flow notice, so the append behavior lives in one place).
 */
function appendNoticeBlock(
  content: CallToolResult['content'],
  title: string,
  body: string,
): void {
  const block = `## ${title}\n${body}`;
  const text = content.find(part => part.type === 'text');
  if (text && text.type === 'text') {
    text.text += `\n\n${block}`;
  } else {
    content.push({type: 'text', text: block});
  }
}

/**
 * On a session's first browser interaction, teaches the model how flows work
 * and to check/reuse an existing one before deriving a new journey. One-shot.
 */
async function appendFirstInteractionNotice(
  sessionId: string,
  content: CallToolResult['content'],
): Promise<void> {
  const notice = await flowService?.consumeFirstInteractionNotice(sessionId);
  if (notice) {
    appendNoticeBlock(content, NOTICE_TITLES.firstInteraction, notice);
  }
}

/**
 * Appends any pending auto-save notices for the session to the tool response
 * text, so the model is told (once) that a draft flow was created, why, and how
 * to use/commit it. No-op when flows are disabled or nothing was auto-saved.
 */
function appendAutoSaveNotices(
  sessionId: string,
  content: CallToolResult['content'],
): void {
  const notices = flowService?.consumeAutoSaveNotices(sessionId) ?? [];
  if (notices.length === 0) {
    return;
  }
  appendNoticeBlock(content, NOTICE_TITLES.autoSave, notices.join('\n'));
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: string): Promise<void> {
  if (sessionManager.isShuttingDown) {
    return;
  }
  logger(`Received ${signal}, shutting down...`);
  idleReaper?.stop();
  try {
    await Promise.race([
      sessionService.shutdown(),
      new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  } catch (err) {
    logger('Error during shutdown:', err);
  }
  process.exit(0);
}

process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

const sessionIdSchema = zod
  .string()
  .describe(
    'The session ID of the Chrome browser instance to use. Obtain one by calling create_session first.',
  );

// Reserved transport-level owner id. Declared on every tool so the MCP SDK's
// schema validation lets it PASS THROUGH (unknown keys are otherwise stripped)
// to extractOwner. It is optional + hidden intent: the host injects it; the
// model never sets it.
const ownerSchema = {
  [OWNER_PARAM]: zod
    .string()
    .optional()
    .describe(
      'Reserved: host-injected caller identity for session isolation. Do not set.',
    ),
};

/**
 * Use-case handlers for the session tools, keyed by tool name. Each returns
 * the response body; the wrapper adds the `# {tool} response` header, logging
 * and uniform error handling so every session tool renders consistently
 * (single source of truth for their response shape).
 */
const sessionToolHandlers: Record<
  string,
  (
    params: Record<string, unknown>,
    owner: string | undefined,
  ) => Promise<string>
> = {
  create_session: async (params, owner) => {
    const {sessionId, body} = await sessionService.createSession({
      headless: params.headless as boolean | undefined,
      viewport: params.viewport as string | undefined,
      label: params.label as string | undefined,
      url: params.url as string | undefined,
      ownerId: owner,
    });
    // Associate this session with its host project so recorded flows and
    // their .env land in the right repo (the shared subprocess serves many
    // projects). Falls back to the server's default root when omitted.
    const projectRoot = params.projectRoot as string | undefined;
    if (projectRoot && flowService) {
      flowService.setSessionProjectRoot(sessionId, projectRoot);
    }
    // The full "how to use flows / reuse an existing one" teaching is surfaced
    // on the session's FIRST browser interaction (the actionable moment),
    // where the correct per-session projectRoot is already set.
    return body;
  },
  list_sessions: async (_params, owner) => sessionService.listSessions(owner),
  close_session: async (params, owner) => {
    const sessionId = params.sessionId as string;
    const result = await sessionService.closeSession(sessionId, owner);
    // Drop the session's action recording buffer to avoid leaks.
    flowService?.disposeRecorder(sessionId);
    return result;
  },
};

function registerSessionTool(tool: ToolDefinition): void {
  const handle = sessionToolHandlers[tool.name];
  if (!handle) {
    throw new Error(`No session handler registered for "${tool.name}".`);
  }
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: {...tool.schema, ...ownerSchema},
      annotations: tool.annotations,
    },
    async (rawParams): Promise<CallToolResult> => {
      // Strip the transport-level owner id before logging/handling so it never
      // appears in output or reaches a handler as a business param.
      const {owner, rest: params} = extractOwner(rawParams);
      try {
        logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
        const body = await handle(params, owner);
        return textResult(`# ${tool.name} response\n${body}`);
      } catch (err) {
        logger(`${tool.name} error:`, err);
        return errorResult(err);
      }
    },
  );
}

function registerBrowserTool(tool: ToolDefinition): void {
  if (
    tool.annotations.category === ToolCategory.EMULATION &&
    args.categoryEmulation === false
  ) {
    return;
  }
  if (
    tool.annotations.category === ToolCategory.PERFORMANCE &&
    args.categoryPerformance === false
  ) {
    return;
  }
  if (
    tool.annotations.category === ToolCategory.NETWORK &&
    args.categoryNetwork === false
  ) {
    return;
  }
  if (
    tool.annotations.category === ToolCategory.EXTENSIONS &&
    args.categoryExtensions === false
  ) {
    return;
  }
  if (
    tool.annotations.conditions?.includes('computerVision') &&
    !args.experimentalVision
  ) {
    return;
  }
  if (
    tool.annotations.conditions?.includes('experimentalInteropTools') &&
    !args.experimentalInteropTools
  ) {
    return;
  }

  // Tools gated on multiTab are always registered but start disabled; they are
  // enabled on demand once a session opens a second tab (see syncMultiTabTools).
  const isMultiTabTool = tool.annotations.conditions?.includes('multiTab');

  if ('sessionId' in tool.schema) {
    throw new Error(
      `Tool "${tool.name}" defines its own sessionId schema, which conflicts with session management.`,
    );
  }

  const schemaWithSession = {
    ...tool.schema,
    sessionId: sessionIdSchema,
    ...ownerSchema,
  };

  const registered = server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: schemaWithSession,
      annotations: tool.annotations,
    },
    async (rawParams): Promise<CallToolResult> => {
      // Strip the transport-level owner id so it never reaches the tool
      // handler or appears in logs/output; use it to scope session access.
      const {owner, rest: params} = extractOwner(rawParams);
      const sessionId = params.sessionId as string;
      if (!sessionId) {
        return errorResult(
          new Error(
            'sessionId is required. Create a session first using create_session.',
          ),
        );
      }

      let session;
      try {
        session = sessionManager.getSession(sessionId, owner);
      } catch (err) {
        return errorResult(err);
      }

      const guard = await session.mutex.acquire();
      try {
        logger(
          `${tool.name} [session=${sessionId}] request: ${JSON.stringify(params, null, '  ')}`,
        );
        const context = session.context;
        // Interacting with a session resets both the tab and the session idle
        // timers so the reaper never touches active work.
        context.touchSelectedPage();
        sessionManager.touchSession(sessionId);
        await context.detectOpenDevToolsWindows();
        const response = new McpResponse();
        await tool.handler({params}, response, context);
        // McpResponse owns the response text, including tab lifecycle notices.
        const {content} = await response.handle(tool.name, context);
        // Record the successful action for the flow recorder (filtered to
        // mutating browser actions inside observe()). The AX-node lookup lets
        // the recorder attach a DURABLE element target next to each ephemeral
        // snapshot uid, so the flow re-resolves elements on replay.
        flowService?.observe(sessionId, tool, params, uid =>
          context.getAXNodeByUid(uid),
        );
        // On the session's first interaction, teach the model how to use flows
        // and to check/reuse an existing one before deriving a new journey.
        await appendFirstInteractionNotice(sessionId, content);
        // Surface any auto-save notices (from a prior turn's async save) so the
        // model learns a draft flow exists, why, and how to use/commit it.
        appendAutoSaveNotices(sessionId, content);
        // Keep the on-demand tab-targeting tools in sync with the tab count.
        syncMultiTabTools();
        return {content};
      } catch (err) {
        logger(`${tool.name} [session=${sessionId}] error:`, err);
        return errorResult(err);
      } finally {
        guard.dispose();
      }
    },
  );

  if (isMultiTabTool) {
    multiTabGate.register(tool.name, registered);
  }
}

/**
 * Registers the experimental `flow` tool. Op logic lives in FlowController;
 * this only adapts params <-> CallToolResult and locks the session for exec.
 */
function registerFlowTool(
  tool: ToolDefinition,
  controller: FlowController,
): void {
  const schemaWithSession = {
    ...tool.schema,
    sessionId: sessionIdSchema.optional(),
    ...ownerSchema,
  };
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: schemaWithSession,
      annotations: tool.annotations,
    },
    async (rawParams): Promise<CallToolResult> => {
      const {owner, rest} = extractOwner(rawParams);
      const params = {...rest, owner} as FlowOpParams;
      try {
        logger(`flow op=${params.op} name=${params.name ?? ''}`);
        const body = await controller.handle(params);
        return textResult(`# flow response\n${body}`);
      } catch (err) {
        logger('flow tool error:', err);
        return errorResult(err);
      }
    },
  );
}

for (const tool of tools) {
  if (sessionToolNames.has(tool.name)) {
    registerSessionTool(tool);
  } else if (tool.name === 'flow') {
    if (flowsEnabled && flowController) {
      registerFlowTool(tool, flowController);
    }
  } else {
    registerBrowserTool(tool);
  }
}

await loadIssueDescriptions();

try {
  const restored = await sessionService.restoreSessions();
  if (restored > 0) {
    logger(`Restored ${restored} persisted session(s)`);
    syncMultiTabTools();
  }
} catch (err) {
  logger('Error restoring persisted sessions:', err);
}

const transport = new StdioServerTransport();
await server.connect(transport);
idleReaper?.start();
logger('Chrome DevTools MCP Server connected (multi-session mode)');

console.error(
  `chrome-devtools-mcp (multi-session) exposes content of browser instances to MCP clients.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.
All browser tools require a sessionId parameter. Use create_session to get one.`,
);
