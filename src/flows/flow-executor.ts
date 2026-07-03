/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {McpResponse} from '../McpResponse.js';
import type {Context, ToolDefinition} from '../tools/ToolDefinition.js';

import type {Flow, FlowAction, FlowStep} from './flow-model.js';
import {isEnvRef} from './flow-model.js';

export interface StepResult {
  name: string;
  status: 'passed' | 'failed';
  actionsRun: number;
  error?: string;
  failedAction?: string;
}

export interface ExecutionResult {
  flow: string;
  status: 'passed' | 'failed';
  steps: StepResult[];
  /** Index of the first failed step, or -1 if all passed. */
  failedStepIndex: number;
}

export interface ExecutorDeps {
  /** Resolves a tool name to its definition (handlers do the real work). */
  getTool(name: string): ToolDefinition | undefined;
  /** Reads an env var; missing values throw during resolution. */
  getEnv(name: string): string | undefined;
  /**
   * Realizes a tool's deferred side-effects after its handler runs. Several
   * tools only set flags in the handler (e.g. `take_snapshot` requests a
   * snapshot; `navigate_page` requests a page-list refresh) and do the actual
   * work inside `McpResponse.handle`. Replaying the handler alone would skip
   * those, breaking snapshot-dependent actions (fill/click by uid). The
   * transport injects this so the executor stays decoupled from McpContext.
   * Optional: omitting it (as tests do) replays handlers only.
   */
  finalize?(
    response: McpResponse,
    toolName: string,
    context: Context,
  ): Promise<void>;
}

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

/**
 * Replays a {@link Flow} against a live session. Actions are executed by
 * re-invoking the corresponding tool handler, so there is no duplicated
 * click/fill/navigate logic (DRY): the flow layer only orchestrates, verifies
 * and times out.
 *
 * Execution stops at the first failing step and reports which step/action
 * failed, so the host can inject that into the model's context and fall back to
 * live tools to repair the flow.
 */
export class FlowExecutor {
  readonly #deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.#deps = deps;
  }

  async run(
    flow: Flow,
    context: Context,
    options: {
      stopAtStep?: string;
      /** Overrides env resolution for this run (per-project .env). */
      getEnv?: (name: string) => string | undefined;
    } = {},
  ): Promise<ExecutionResult> {
    const steps: StepResult[] = [];
    let failedStepIndex = -1;
    const getEnv = options.getEnv ?? this.#deps.getEnv;

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const result = await this.#runStep(step, context, getEnv);
      steps.push(result);
      if (result.status === 'failed') {
        failedStepIndex = i;
        break;
      }
      if (options.stopAtStep && step.name === options.stopAtStep) {
        break;
      }
    }

    return {
      flow: flow.name,
      status: failedStepIndex === -1 ? 'passed' : 'failed',
      steps,
      failedStepIndex,
    };
  }

  async #runStep(
    step: FlowStep,
    context: Context,
    getEnv: (name: string) => string | undefined,
  ): Promise<StepResult> {
    let actionsRun = 0;
    for (const action of step.actions) {
      try {
        await this.#runAction(action, context, getEnv);
        actionsRun++;
      } catch (err) {
        return {
          name: step.name,
          status: 'failed',
          actionsRun,
          failedAction: action.tool,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return {name: step.name, status: 'passed', actionsRun};
  }

  async #runAction(
    action: FlowAction,
    context: Context,
    getEnv: (name: string) => string | undefined,
  ): Promise<void> {
    const tool = this.#deps.getTool(action.tool);
    if (!tool) {
      throw new Error(`Unknown tool "${action.tool}".`);
    }
    const params = this.#resolveParams(action.params, getEnv);
    const timeout =
      typeof params.timeout === 'number'
        ? params.timeout
        : DEFAULT_ACTION_TIMEOUT_MS;

    const response = new McpResponse();
    await this.#withTimeout(
      (async () => {
        await tool.handler({params}, response, context);
        // Realize deferred effects (snapshot creation, page refresh, ...) so
        // later actions that depend on them (fill/click by snapshot uid) work.
        if (this.#deps.finalize) {
          await this.#deps.finalize(response, action.tool, context);
        }
      })(),
      timeout,
      `${action.tool} timed out after ${timeout}ms`,
    );
  }

  /** Replaces env references with their resolved values. */
  #resolveParams(
    params: FlowAction['params'],
    getEnv: (name: string) => string | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (isEnvRef(value)) {
        const resolved = getEnv(value.__env);
        if (resolved === undefined) {
          throw new Error(
            `Missing environment variable "${value.__env}". Set it in .env.`,
          );
        }
        out[key] = resolved;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  async #withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
