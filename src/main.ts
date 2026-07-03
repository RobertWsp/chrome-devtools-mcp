/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './polyfill.js';

import process from 'node:process';

import {parseArguments} from './cli.js';
import {FlowController, type FlowOpParams} from './flows/FlowController.js';
import {FlowService} from './flows/FlowService.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger, saveLogsToFile} from './logger.js';
import {McpResponse} from './McpResponse.js';
import {textResult, errorResult} from './McpResult.js';
import {MultiTabToolGate} from './MultiTabToolGate.js';
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
const sessionManager = new SessionManager(
  {
    experimentalDevToolsDebugging: devtools,
    experimentalIncludeAllPages: args.experimentalIncludeAllPages,
    performanceCrux: args.performanceCrux,
  },
  {registry: sessionRegistry, detached: persistSessions},
);

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
  ? new FlowController(flowService, async (sessionId, run) => {
      const session = sessionManager.getSession(sessionId);
      const guard = await session.mutex.acquire();
      try {
        return await run(session.context);
      } finally {
        guard.dispose();
      }
    })
  : undefined;

/**
 * When flows are enabled, produce a short reminder listing reusable flows so
 * the model checks for an existing one before re-deriving a journey.
 */
async function flowNoticeForNewSession(): Promise<string | undefined> {
  if (!flowService) {
    return undefined;
  }
  const flows = await flowService.list();
  const header =
    'Flow recording is active. Before building a multi-step journey, reuse an existing flow with the `flow` tool (op=list, op=exec) when possible; save new journeys with op=save.';
  if (flows.length === 0) {
    return header;
  }
  const names = flows.map(
    f => `${f.name} (${f.description || 'no description'})`,
  );
  return `${header}\nExisting flows: ${names.join('; ')}.`;
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: string): Promise<void> {
  if (sessionManager.isShuttingDown) {
    return;
  }
  logger(`Received ${signal}, shutting down...`);
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

/**
 * Use-case handlers for the session tools, keyed by tool name. Each returns
 * the response body; the wrapper adds the `# {tool} response` header, logging
 * and uniform error handling so every session tool renders consistently
 * (single source of truth for their response shape).
 */
const sessionToolHandlers: Record<
  string,
  (params: Record<string, unknown>) => Promise<string>
> = {
  create_session: async params => {
    const body = await sessionService.createSession({
      headless: params.headless as boolean | undefined,
      viewport: params.viewport as string | undefined,
      label: params.label as string | undefined,
      url: params.url as string | undefined,
    });
    // Nudge the model to reuse existing flows before deriving a new journey.
    const flowNotice = await flowNoticeForNewSession();
    return flowNotice ? `${body}\n\n${flowNotice}` : body;
  },
  list_sessions: async () => sessionService.listSessions(),
  close_session: async params => {
    const sessionId = params.sessionId as string;
    const result = await sessionService.closeSession(sessionId);
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
      inputSchema: tool.schema,
      annotations: tool.annotations,
    },
    async (params): Promise<CallToolResult> => {
      try {
        logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
        const body = await handle(params);
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
  };

  const registered = server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: schemaWithSession,
      annotations: tool.annotations,
    },
    async (params): Promise<CallToolResult> => {
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
        session = sessionManager.getSession(sessionId);
      } catch (err) {
        return errorResult(err);
      }

      const guard = await session.mutex.acquire();
      try {
        logger(
          `${tool.name} [session=${sessionId}] request: ${JSON.stringify(params, null, '  ')}`,
        );
        const context = session.context;
        // Interacting with a session resets the selected tab's idle timer.
        context.touchSelectedPage();
        await context.detectOpenDevToolsWindows();
        const response = new McpResponse();
        await tool.handler({params}, response, context);
        // McpResponse owns the response text, including tab lifecycle notices.
        const {content} = await response.handle(tool.name, context);
        // Record the successful action for the flow recorder (filtered to
        // mutating browser actions inside observe()).
        flowService?.observe(sessionId, tool, params);
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
  };
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: schemaWithSession,
      annotations: tool.annotations,
    },
    async (rawParams): Promise<CallToolResult> => {
      const params = rawParams as FlowOpParams;
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
logger('Chrome DevTools MCP Server connected (multi-session mode)');

console.error(
  `chrome-devtools-mcp (multi-session) exposes content of browser instances to MCP clients.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.
All browser tools require a sessionId parameter. Use create_session to get one.`,
);
