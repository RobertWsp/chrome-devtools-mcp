/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {McpResponse} from '../McpResponse.js';
import type {Context, ToolDefinition} from '../tools/ToolDefinition.js';

import {UID_PARAM_KEYS, targetKeyFor} from './action-normalizer.js';
import {
  type ElementTarget,
  isElementTarget,
  TARGET_PARAM,
} from './element-target.js';
import type {Flow, FlowAction, FlowStep} from './flow-model.js';
import {isEnvRef} from './flow-model.js';

/** Error when a durable target no longer matches any element on the page. */
function targetMissError(target: ElementTarget): string {
  const label = target.name ? `"${target.name}"` : `role=${target.role}`;
  return (
    `element ${label} (role=${target.role}) was not found on the current ` +
    `page. The page structure changed since the flow was recorded; inspect it ` +
    `with the browser tools and update the step (re-record it or edit the ` +
    `.cdp.ts).`
  );
}

export interface StepResult {
  name: string;
  /**
   * `passed`/`failed` for steps the runner reached; `skipped` for steps AFTER
   * the first failure (never run, but reported so the ledger shows the whole
   * flow and where it stopped).
   */
  status: 'passed' | 'failed' | 'skipped';
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
const DEFAULT_PRECONDITION_TIMEOUT_MS = 5_000;

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
      /** Start replay at this step (skip the ones BEFORE it). */
      startAtStep?: string;
      /** Stop after this step (skip the ones AFTER it). */
      stopAtStep?: string;
      /** Overrides env resolution for this run (per-project .env). */
      getEnv?: (name: string) => string | undefined;
    } = {},
  ): Promise<ExecutionResult> {
    const getEnv = options.getEnv ?? this.#deps.getEnv;
    // Resolve the CONTIGUOUS [start, stop] window. Steps within the window are
    // never skipped -- start/stop only trim the ends (resume an already-done
    // prefix, or stop early); everything between runs in order.
    const {start, stop} = this.#resolveWindow(flow, options);

    const steps: StepResult[] = [];
    let failedStepIndex = -1;

    for (let i = start; i <= stop; i++) {
      const step = flow.steps[i];
      if (failedStepIndex !== -1) {
        // A prior step failed: report the rest as skipped (never run) so the
        // ledger shows the full flow and exactly where it stopped.
        steps.push({name: step.name, status: 'skipped', actionsRun: 0});
        continue;
      }
      const result = await this.#runStep(step, context, getEnv);
      steps.push(result);
      if (result.status === 'failed') {
        failedStepIndex = steps.length - 1;
      }
    }

    return {
      flow: flow.name,
      status: failedStepIndex === -1 ? 'passed' : 'failed',
      steps,
      failedStepIndex,
    };
  }

  /**
   * Resolves the contiguous [start, stop] index window from optional
   * start/stop step NAMES. Unknown names throw (never silently run the whole
   * flow), and start>stop throws (an inverted range is a mistake, not a skip).
   */
  #resolveWindow(
    flow: Flow,
    options: {startAtStep?: string; stopAtStep?: string},
  ): {start: number; stop: number} {
    const indexOf = (label: string, name: string): number => {
      const idx = flow.steps.findIndex(s => s.name === name);
      if (idx === -1) {
        throw new Error(
          `${label} "${name}" is not a step of flow "${flow.name}". Steps: ${flow.steps
            .map(s => s.name)
            .join(', ')}.`,
        );
      }
      return idx;
    };
    const start = options.startAtStep
      ? indexOf('startAtStep', options.startAtStep)
      : 0;
    const stop = options.stopAtStep
      ? indexOf('stopAtStep', options.stopAtStep)
      : flow.steps.length - 1;
    if (start > stop) {
      throw new Error(
        `startAtStep "${options.startAtStep}" comes after stopAtStep "${options.stopAtStep}" in flow "${flow.name}"; the range is empty.`,
      );
    }
    return {start, stop};
  }

  async #runStep(
    step: FlowStep,
    context: Context,
    getEnv: (name: string) => string | undefined,
  ): Promise<StepResult> {
    // Verify the step's precondition first: replay must confirm the page is in
    // the expected state, never blindly fire actions or silently skip. An
    // unmet precondition is a FAILURE with a clear, actionable message.
    if (step.precondition) {
      const unmet = await this.#checkPrecondition(step.precondition, context);
      if (unmet) {
        return {
          name: step.name,
          status: 'failed',
          actionsRun: 0,
          failedAction: 'precondition',
          error: unmet,
        };
      }
    }

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

  /**
   * Returns an error message when the precondition is NOT satisfied, or
   * undefined when it holds. Waits up to `timeoutMs` for the selector to
   * appear so a step that legitimately follows a navigation still passes once
   * the page settles.
   */
  async #checkPrecondition(
    precondition: NonNullable<FlowStep['precondition']>,
    context: Context,
  ): Promise<string | undefined> {
    const timeout = precondition.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS;
    let page: ReturnType<Context['getSelectedPage']>;
    try {
      page = context.getSelectedPage();
    } catch (err) {
      return `precondition could not resolve the active page: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    try {
      await page.waitForSelector(precondition.selector, {
        visible: true,
        timeout,
      });
      return undefined;
    } catch {
      return (
        `precondition not met: expected element "${precondition.selector}" to be ` +
        `present on ${page.url()} within ${timeout}ms. The page is not in the ` +
        `expected state for this step; inspect it with the browser tools and ` +
        `repair the flow (update the step's actions or its precondition).`
      );
    }
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
    // Re-resolve durable element targets to FRESH snapshot uids so the action
    // addresses the live element even though the recorded uid is stale.
    await this.#resolveTargets(params, context);
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

  /**
   * Rewrites ephemeral snapshot uids from their DURABLE targets against the
   * CURRENT page, and strips the target markers before the handler runs. This
   * is what makes replay resilient: the recorded uid belongs to a stale
   * snapshot namespace, so we re-resolve role+name to a fresh uid. Throws a
   * clear error when a target no longer matches, so the step fails loudly
   * instead of the tool erroring with an opaque "No such element".
   *
   * No-op when the params carry no targets (e.g. navigate_page) or the context
   * cannot resolve them (unit tests with fake contexts) -- then the raw uid is
   * used as-is, preserving the previous behavior.
   */
  async #resolveTargets(
    params: Record<string, unknown>,
    context: Context,
  ): Promise<void> {
    const hasTargets = Object.keys(params).some(
      k => k === TARGET_PARAM || k.startsWith(`${TARGET_PARAM}_`),
    );
    const elements = params.elements;
    const elementsHaveTargets =
      Array.isArray(elements) &&
      elements.some(
        el =>
          el &&
          typeof el === 'object' &&
          TARGET_PARAM in (el as Record<string, unknown>),
      );
    if (!hasTargets && !elementsHaveTargets) {
      return;
    }
    // Fake context (unit tests) exposes neither method: keep the raw uids and
    // just strip the markers so the handler receives clean params.
    const canResolve = typeof context.resolveUidByTarget === 'function';
    if (typeof context.createTextSnapshot === 'function') {
      // Capture the live DOM so target resolution sees the current elements.
      await context.createTextSnapshot();
    }
    const resolve = (target: ElementTarget): string | undefined =>
      canResolve ? context.resolveUidByTarget(target) : undefined;

    for (const uidKey of UID_PARAM_KEYS) {
      const targetKey = targetKeyFor(uidKey);
      const target = params[targetKey];
      if (isElementTarget(target)) {
        const fresh = resolve(target);
        if (fresh) {
          params[uidKey] = fresh;
        } else if (canResolve) {
          throw new Error(targetMissError(target));
        }
        delete params[targetKey];
      }
    }

    if (Array.isArray(elements)) {
      params.elements = elements.map(el => {
        if (!el || typeof el !== 'object') {
          return el;
        }
        const entry = {...(el as Record<string, unknown>)};
        const target = entry[TARGET_PARAM];
        if (isElementTarget(target)) {
          const fresh = resolve(target);
          if (fresh) {
            entry.uid = fresh;
          } else if (canResolve) {
            throw new Error(targetMissError(target));
          }
          delete entry[TARGET_PARAM];
        }
        return entry;
      });
    }
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
