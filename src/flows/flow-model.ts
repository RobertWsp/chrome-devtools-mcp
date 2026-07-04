/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

/**
 * Single source of truth for the flow AST. The `.cdp.ts` file on disk is a
 * serialization of this structure (codegen writes it, the parser reads it
 * back), so every consumer -- recorder, executor, validator, codegen -- agrees
 * on one shape.
 *
 * A flow is an ordered list of named steps. A step is a cohesive block of
 * actions (e.g. "login") that can be replayed and verified independently, so
 * the runner can report exactly which block failed and resume from it.
 */

/** Reference to a secret resolved from the environment at execution time. */
export interface EnvRef {
  /** Marker discriminating an env reference from a literal string. */
  __env: string;
}

export function envRef(name: string): EnvRef {
  return {__env: name};
}

export function isEnvRef(value: unknown): value is EnvRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EnvRef).__env === 'string'
  );
}

/**
 * A single recorded action. `tool` is the MCP tool name and `params` are its
 * arguments with any secret values replaced by {@link EnvRef} placeholders.
 * Replaying an action is just re-invoking that tool's handler, which keeps the
 * executor free of duplicated click/fill/navigate logic (DRY).
 */
export const flowActionSchema = zod.object({
  tool: zod.string().min(1),
  params: zod.record(zod.string(), zod.unknown()).default({}),
});
export type FlowAction = zod.infer<typeof flowActionSchema>;

/**
 * A step precondition: a guard that must hold BEFORE the step's actions run,
 * so replay verifies the page is in the expected state instead of blindly
 * firing clicks/fills that would fail cryptically (or worse, act on the wrong
 * page). It is a VERIFICATION gate, never a skip: if it does not hold, the step
 * FAILS with a clear message. Steps are never skipped.
 *
 *   selector  a CSS selector that must resolve to a visible element before the
 *             step runs (e.g. the login form must be present to fill it).
 *   timeoutMs how long to wait for it to appear (default 5000).
 *
 * A step whose first action is a direct navigation needs no precondition (the
 * navigation establishes the page), so this is optional.
 */
export const stepPreconditionSchema = zod.object({
  selector: zod.string().min(1),
  timeoutMs: zod.number().int().positive().optional(),
});
export type StepPrecondition = zod.infer<typeof stepPreconditionSchema>;

export const flowStepSchema = zod.object({
  name: zod.string().min(1),
  description: zod.string().optional(),
  /** Optional guard verified before the step runs (never a skip). */
  precondition: stepPreconditionSchema.optional(),
  actions: zod.array(flowActionSchema),
});
export type FlowStep = zod.infer<typeof flowStepSchema>;

export const flowSchema = zod.object({
  /** Stable, file-name-safe identifier (kebab/snake). */
  name: zod
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      'Flow name must be lowercase alphanumeric with - or _.',
    ),
  description: zod.string().default(''),
  /** Names of environment variables the flow depends on. */
  env: zod.array(zod.string()).default([]),
  steps: zod.array(flowStepSchema),
  createdAt: zod.string().optional(),
  updatedAt: zod.string().optional(),
});
export type Flow = zod.infer<typeof flowSchema>;

export const FLOW_FILE_EXTENSION = '.cdp.ts';
export const FLOWS_DIR = '.cdpflows';

/** Parses and validates an untrusted object into a {@link Flow}. */
export function parseFlow(data: unknown): Flow {
  return flowSchema.parse(data);
}

/**
 * Parses an untrusted JSON string into an array of {@link FlowStep} (used when
 * a host agent supplies a semantic step decomposition on save). Throws with a
 * readable message on malformed input.
 */
export function parseFlowSteps(json: string): FlowStep[] {
  const data = JSON.parse(json);
  return zod.array(flowStepSchema).parse(data);
}

/** Total action count across all steps -- used for summaries. */
export function countActions(flow: Flow): number {
  return flow.steps.reduce((sum, step) => sum + step.actions.length, 0);
}
