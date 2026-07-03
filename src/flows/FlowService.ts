/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

import {logger} from '../logger.js';
import type {McpContext} from '../McpContext.js';
import type {McpResponse} from '../McpResponse.js';
import {Mutex} from '../Mutex.js';
import type {Context, ToolDefinition} from '../tools/ToolDefinition.js';

import {ActionRecorder} from './action-recorder.js';
import {AutoSaver} from './auto-saver.js';
import {persistSecrets, readEnvFile} from './env-file.js';
import type {ExecutionResult} from './flow-executor.js';
import {FlowExecutor} from './flow-executor.js';
import type {Flow} from './flow-model.js';
import {countActions} from './flow-model.js';
import {FlowStore, type FlowSummary} from './flow-store.js';
import type {ValidationResult} from './flow-validator.js';
import {validateFlow, validateFlowSource} from './flow-validator.js';
import {extractSecrets} from './secret-scanner.js';

export interface FlowServiceOptions {
  /** Fallback project root when a session did not declare one. */
  projectRoot: string;
  /** All registered tools, used to resolve handlers and validate names. */
  tools: readonly ToolDefinition[];
  /** Overrides env resolution (tests). When set, disables .env + finalize. */
  getEnv?: (name: string) => string | undefined;
  /**
   * Silently persist a draft flow when a journey boundary is detected, so a
   * useful recording is never lost even if the model never calls op=save.
   * Default true; disabled automatically in test mode (custom getEnv).
   */
  autoSave?: boolean;
}

/**
 * Facade over the flow subsystem: recording, persistence, validation and
 * replay. Keeps the transport layer thin and gives the host a single, testable
 * surface.
 *
 * Project isolation: the mcp-chrome subprocess is shared across host sessions
 * that may live in different projects, so a single global project root is
 * wrong. Each session declares its own root (via create_session); flows and
 * secrets are stored under that session's root. Stores are cached per root so
 * two sessions in the same project share one on-disk view.
 */
export class FlowService {
  readonly #defaultRoot: string;
  readonly #executor: FlowExecutor;
  readonly #toolsByName: Map<string, ToolDefinition>;
  readonly #knownTools: Set<string>;
  readonly #recorders = new Map<string, ActionRecorder>();
  readonly #sessionRoot = new Map<string, string>();
  readonly #storesByRoot = new Map<string, FlowStore>();
  readonly #customGetEnv?: (name: string) => string | undefined;
  readonly #autoSaver: AutoSaver;
  readonly #autoSaveEnabled: boolean;
  // Serializes auto-save per session so two fast actions can't race into a
  // double save + corrupt buffer trim.
  readonly #autoSaveMutex = new Map<string, Mutex>();

  constructor(options: FlowServiceOptions) {
    this.#defaultRoot = options.projectRoot;
    this.#toolsByName = new Map(options.tools.map(t => [t.name, t]));
    this.#knownTools = new Set(this.#toolsByName.keys());
    this.#customGetEnv = options.getEnv;
    this.#autoSaver = new AutoSaver();
    // Auto-save runs in production only; test mode injects getEnv and drives
    // persistence explicitly.
    this.#autoSaveEnabled = options.autoSave ?? !options.getEnv;
    // Replay realizes deferred side-effects (snapshot creation, page refresh)
    // via McpResponse.handle so snapshot-dependent actions (fill/click by uid)
    // work. Wired only in production; unit tests inject getEnv + fakes and
    // replay handlers-only.
    const finalize = options.getEnv
      ? undefined
      : (response: McpResponse, toolName: string, context: Context) =>
          response
            .handle(toolName, context as McpContext)
            .then(() => undefined);
    this.#executor = new FlowExecutor({
      getTool: name => this.#toolsByName.get(name),
      getEnv: name => this.#getEnv(name),
      finalize,
    });
  }

  // --- project root --------------------------------------------------------

  /** Associates a session with its host project root (from create_session). */
  setSessionProjectRoot(sessionId: string, projectRoot: string): void {
    this.#sessionRoot.set(sessionId, projectRoot);
  }

  /** Resolves the project root for a session, falling back to the default. */
  #rootFor(sessionId: string | undefined): string {
    return (sessionId && this.#sessionRoot.get(sessionId)) || this.#defaultRoot;
  }

  #storeFor(sessionId: string | undefined): FlowStore {
    const root = this.#rootFor(sessionId);
    let store = this.#storesByRoot.get(root);
    if (!store) {
      store = new FlowStore(root);
      this.#storesByRoot.set(root, store);
    }
    return store;
  }

  /** Env resolution: session/default `.env` first, real env as fallback. */
  #getEnv(name: string, sessionId?: string): string | undefined {
    if (this.#customGetEnv) {
      return this.#customGetEnv(name);
    }
    const fromFile = readEnvFile(this.#rootFor(sessionId)).get(name);
    if (fromFile !== undefined) {
      return fromFile;
    }
    return process.env[name];
  }

  // --- recording -----------------------------------------------------------

  recorderFor(sessionId: string): ActionRecorder {
    let recorder = this.#recorders.get(sessionId);
    if (!recorder) {
      recorder = new ActionRecorder();
      this.#recorders.set(sessionId, recorder);
    }
    return recorder;
  }

  disposeRecorder(sessionId: string): void {
    this.#recorders.delete(sessionId);
    this.#sessionRoot.delete(sessionId);
    this.#autoSaveMutex.delete(sessionId);
  }

  /**
   * Records a successful tool call into the session's buffer. Safe to call for
   * every tool; the recorder filters to mutating browser actions.
   */
  observe(
    sessionId: string,
    tool: ToolDefinition,
    params: Record<string, unknown>,
  ): void {
    const recorder = this.recorderFor(sessionId);
    const before = recorder.size;
    recorder.record(tool, params);
    // Only evaluate when the action was actually recorded (mutating browser
    // action); read-only tools don't advance a journey.
    if (this.#autoSaveEnabled && recorder.size > before) {
      void this.#maybeAutoSave(sessionId).catch(err => {
        logger('flow auto-save error:', err);
      });
    }
  }

  #autoSaveMutexFor(sessionId: string): Mutex {
    let mutex = this.#autoSaveMutex.get(sessionId);
    if (!mutex) {
      mutex = new Mutex();
      this.#autoSaveMutex.set(sessionId, mutex);
    }
    return mutex;
  }

  /**
   * Persists the current journey as a draft flow when the auto-saver detects a
   * boundary. The auto-saver owns the trim semantics (retainAfterSave), so the
   * caller never re-derives them from a message. Serialized per session so
   * concurrent observes can't double-save or corrupt the buffer trim.
   * Best-effort and silent.
   */
  async #maybeAutoSave(sessionId: string): Promise<void> {
    const guard = await this.#autoSaveMutexFor(sessionId).acquire();
    try {
      const recorder = this.recorderFor(sessionId);
      const buffer = recorder.snapshot();
      const decision = this.#autoSaver.evaluate(buffer);
      if (!decision.save || !decision.suggestedName) {
        return;
      }
      const retain = decision.retainAfterSave ?? 0;
      const journey =
        retain > 0 && buffer.length > retain
          ? buffer.slice(0, buffer.length - retain)
          : buffer;
      if (journey.length === 0) {
        return;
      }
      const draft: Flow = {
        name: decision.suggestedName,
        description: `Auto-saved journey (${decision.reason ?? 'boundary'}). Rename/refine with flow op=save.`,
        env: [],
        steps: [{name: 'journey', actions: journey}],
      };
      await this.saveFlow(draft, sessionId);
      logger(
        `flow auto-saved "${draft.name}" (${journey.length} action(s)) for session ${sessionId}`,
      );
      // Trim what we saved so the next journey records cleanly.
      recorder.retainTail(retain);
    } finally {
      guard.dispose();
    }
  }

  /**
   * Returns the current recording buffer as a draft flow (single "recording"
   * step). This is what an external orchestrator (e.g. the host agent) reads to
   * restructure raw actions into semantic steps before saving.
   */
  draftRecording(sessionId: string): Flow {
    return {
      name: 'draft',
      description: '',
      env: [],
      steps: [
        {name: 'recording', actions: this.recorderFor(sessionId).snapshot()},
      ],
    };
  }

  // --- persistence ---------------------------------------------------------

  /**
   * Saves the current recording as a named flow into the session's project.
   * If `steps` are provided (a semantic decomposition), they are used as-is;
   * otherwise the raw buffer is wrapped in a single "main" step.
   */
  async saveRecording(
    sessionId: string,
    name: string,
    description = '',
    steps?: Flow['steps'],
  ): Promise<{file: string; validation: ValidationResult; flow: Flow}> {
    const actions = this.recorderFor(sessionId).snapshot();
    const draft: Flow = {
      name,
      description,
      env: [],
      steps: steps && steps.length > 0 ? steps : [{name: 'main', actions}],
    };
    return this.saveFlow(draft, sessionId);
  }

  /**
   * Persists a flow after extracting secrets and validating. The single write
   * path for both recordings and edited flows (SSoT for how flows reach disk).
   */
  async saveFlow(
    draft: Flow,
    sessionId?: string,
  ): Promise<{file: string; validation: ValidationResult; flow: Flow}> {
    const store = this.#storeFor(sessionId);
    const {flow, secrets} = extractSecrets(draft);
    const validation = validateFlow(flow, {knownTools: this.#knownTools});
    if (!validation.valid) {
      const errors = validation.issues
        .filter(i => i.severity === 'error')
        .map(i => i.message)
        .join('; ');
      throw new Error(`Flow validation failed: ${errors}`);
    }
    await persistSecrets(store.projectRoot, secrets);
    const file = await store.save(flow);
    return {file, validation, flow};
  }

  // --- queries -------------------------------------------------------------

  list(sessionId?: string): Promise<FlowSummary[]> {
    return this.#storeFor(sessionId).list();
  }

  load(name: string, sessionId?: string): Promise<Flow> {
    return this.#storeFor(sessionId).load(name);
  }

  readSource(name: string, sessionId?: string): Promise<string> {
    return this.#storeFor(sessionId).readSource(name);
  }

  exists(name: string, sessionId?: string): Promise<boolean> {
    return this.#storeFor(sessionId).exists(name);
  }

  // --- validation ----------------------------------------------------------

  validateSource(source: string): ValidationResult {
    return validateFlowSource(source, {knownTools: this.#knownTools});
  }

  async validateStored(
    name: string,
    sessionId?: string,
  ): Promise<ValidationResult> {
    const source = await this.#storeFor(sessionId).readSource(name);
    return this.validateSource(source);
  }

  // --- replay --------------------------------------------------------------

  async exec(
    name: string,
    context: Context,
    options: {stopAtStep?: string; sessionId?: string} = {},
  ): Promise<ExecutionResult> {
    const flow = await this.#storeFor(options.sessionId).load(name);
    // Read the project's .env once per run (not per env-ref) so a flow with
    // many secrets does not re-read the file repeatedly. Real env vars still
    // win over the file, matching #getEnv semantics.
    const fileEnv = this.#customGetEnv
      ? undefined
      : readEnvFile(this.#rootFor(options.sessionId));
    const getEnv = (envName: string): string | undefined => {
      if (this.#customGetEnv) {
        return this.#customGetEnv(envName);
      }
      return fileEnv?.get(envName) ?? process.env[envName];
    };
    return this.#executor.run(flow, context, {
      stopAtStep: options.stopAtStep,
      getEnv,
    });
  }

  summarize(flow: Flow): string {
    return `${flow.name}: ${flow.steps.length} step(s), ${countActions(flow)} action(s)`;
  }
}
