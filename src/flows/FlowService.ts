/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

import type {McpContext} from '../McpContext.js';
import type {McpResponse} from '../McpResponse.js';
import type {Context, ToolDefinition} from '../tools/ToolDefinition.js';

import {ActionRecorder} from './action-recorder.js';
import {loadEnvFile, persistSecrets} from './env-file.js';
import type {ExecutionResult} from './flow-executor.js';
import {FlowExecutor} from './flow-executor.js';
import type {Flow} from './flow-model.js';
import {countActions} from './flow-model.js';
import {FlowStore, type FlowSummary} from './flow-store.js';
import type {ValidationResult} from './flow-validator.js';
import {validateFlow, validateFlowSource} from './flow-validator.js';
import {extractSecrets} from './secret-scanner.js';

export interface FlowServiceOptions {
  projectRoot: string;
  /** All registered tools, used to resolve handlers and validate names. */
  tools: readonly ToolDefinition[];
  getEnv?: (name: string) => string | undefined;
}

/**
 * Facade over the flow subsystem: recording, persistence, validation and
 * replay. Keeps the transport layer (tool handler) thin and gives the host a
 * single, testable surface. One recorder per session enforces isolation.
 */
export class FlowService {
  readonly #store: FlowStore;
  readonly #executor: FlowExecutor;
  readonly #toolsByName: Map<string, ToolDefinition>;
  readonly #knownTools: Set<string>;
  readonly #recorders = new Map<string, ActionRecorder>();
  readonly #getEnv: (name: string) => string | undefined;

  constructor(options: FlowServiceOptions) {
    this.#store = new FlowStore(options.projectRoot);
    this.#toolsByName = new Map(options.tools.map(t => [t.name, t]));
    this.#knownTools = new Set(this.#toolsByName.keys());
    // Load persisted secrets so flow env references resolve at replay time.
    // Skipped when a custom getEnv is supplied (tests inject their own env).
    if (!options.getEnv) {
      loadEnvFile(options.projectRoot);
    }
    this.#getEnv = options.getEnv ?? (name => process.env[name]);
    // Replay depends on deferred side-effects (snapshot creation, page refresh)
    // that live in McpResponse.handle; without finalizing, snapshot-dependent
    // actions (fill/click by uid) break on replay. Wired only in production;
    // unit tests inject getEnv + fake tools/contexts and replay handlers-only.
    const finalize = options.getEnv
      ? undefined
      : (response: McpResponse, toolName: string, context: Context) =>
          response
            .handle(toolName, context as McpContext)
            .then(() => undefined);
    this.#executor = new FlowExecutor({
      getTool: name => this.#toolsByName.get(name),
      getEnv: this.#getEnv,
      finalize,
    });
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
    this.recorderFor(sessionId).record(tool, params);
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
   * Saves the current recording as a named flow. If `steps` are provided (e.g.
   * a semantic decomposition produced by the host agent), they are used as-is;
   * otherwise the raw buffer is wrapped in a single "main" step. Either way the
   * result goes through the single {@link saveFlow} write path (secret
   * extraction + validation).
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
    return this.saveFlow(draft);
  }

  /**
   * Persists a flow after extracting secrets and validating. The single write
   * path for both recordings and edited flows (SSoT for how flows reach disk).
   */
  async saveFlow(
    draft: Flow,
  ): Promise<{file: string; validation: ValidationResult; flow: Flow}> {
    const {flow, secrets} = extractSecrets(draft);
    const validation = validateFlow(flow, {knownTools: this.#knownTools});
    if (!validation.valid) {
      const errors = validation.issues
        .filter(i => i.severity === 'error')
        .map(i => i.message)
        .join('; ');
      throw new Error(`Flow validation failed: ${errors}`);
    }
    await persistSecrets(this.#store.projectRoot, secrets);
    const file = await this.#store.save(flow);
    return {file, validation, flow};
  }

  // --- queries -------------------------------------------------------------

  list(): Promise<FlowSummary[]> {
    return this.#store.list();
  }

  load(name: string): Promise<Flow> {
    return this.#store.load(name);
  }

  readSource(name: string): Promise<string> {
    return this.#store.readSource(name);
  }

  exists(name: string): Promise<boolean> {
    return this.#store.exists(name);
  }

  // --- validation ----------------------------------------------------------

  validateSource(source: string): ValidationResult {
    return validateFlowSource(source, {knownTools: this.#knownTools});
  }

  async validateStored(name: string): Promise<ValidationResult> {
    const source = await this.#store.readSource(name);
    return this.validateSource(source);
  }

  // --- replay --------------------------------------------------------------

  async exec(
    name: string,
    context: Context,
    options: {stopAtStep?: string} = {},
  ): Promise<ExecutionResult> {
    const flow = await this.#store.load(name);
    return this.#executor.run(flow, context, options);
  }

  summarize(flow: Flow): string {
    return `${flow.name}: ${flow.steps.length} step(s), ${countActions(flow)} action(s)`;
  }
}
