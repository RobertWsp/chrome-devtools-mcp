/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Flow} from './flow-model.js';
import {flowSchema} from './flow-model.js';
import {parseFlowSource} from './flow-parser.js';
import {findLeakedSecrets} from './secret-scanner.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  flow?: Flow;
  issues: ValidationIssue[];
}

export interface ValidatorOptions {
  /** Known MCP tool names; unknown tools in a flow are flagged as errors. */
  knownTools: ReadonlySet<string>;
  /** Upper bound for a per-action timeout param, in ms. */
  maxTimeoutMs?: number;
}

const DEFAULT_MAX_TIMEOUT_MS = 120_000;

/**
 * Embedded harness that validates a flow before it is trusted for replay or
 * commit. It is deliberately pure and dependency-light so it can run on every
 * write (the "write-time harness" the user asked for). Checks:
 *  - source parses and matches the schema,
 *  - every referenced tool exists,
 *  - timeouts are sane,
 *  - no raw secret literals survived extraction,
 *  - declared env vars line up with referenced ones.
 */
export function validateFlowSource(
  source: string,
  options: ValidatorOptions,
): ValidationResult {
  let flow: Flow;
  try {
    flow = parseFlowSource(source);
  } catch (err) {
    return {
      valid: false,
      issues: [
        {
          severity: 'error',
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  return validateFlow(flow, options);
}

export function validateFlow(
  flow: Flow,
  options: ValidatorOptions,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  const schemaResult = flowSchema.safeParse(flow);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      issues.push({
        severity: 'error',
        message: `Schema: ${issue.path.join('.') || '(root)'} ${issue.message}`,
      });
    }
    return {valid: false, issues};
  }

  const maxTimeout = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;

  if (flow.steps.length === 0) {
    issues.push({severity: 'warning', message: 'Flow has no steps.'});
  }

  const referencedEnv = new Set<string>();
  for (const step of flow.steps) {
    if (step.actions.length === 0) {
      issues.push({
        severity: 'warning',
        message: `Step "${step.name}" has no actions.`,
      });
    }
    for (const action of step.actions) {
      if (!options.knownTools.has(action.tool)) {
        issues.push({
          severity: 'error',
          message: `Step "${step.name}" uses unknown tool "${action.tool}".`,
        });
      }
      const timeout = action.params.timeout;
      if (typeof timeout === 'number' && timeout > maxTimeout) {
        issues.push({
          severity: 'warning',
          message: `Step "${step.name}" > ${action.tool} timeout ${timeout}ms exceeds ${maxTimeout}ms.`,
        });
      }
      for (const value of Object.values(action.params)) {
        if (
          typeof value === 'object' &&
          value !== null &&
          '__env' in value &&
          typeof (value as {__env: unknown}).__env === 'string'
        ) {
          referencedEnv.add((value as {__env: string}).__env);
        }
      }
    }
  }

  // Security gate: a committed flow must never embed a raw secret.
  for (const leak of findLeakedSecrets(flow)) {
    issues.push({
      severity: 'error',
      message: `Possible plaintext secret at ${leak}. Move it to .env and reference via env(...).`,
    });
  }

  for (const name of referencedEnv) {
    if (!flow.env.includes(name)) {
      issues.push({
        severity: 'warning',
        message: `env("${name}") is used but not declared in the flow's env list.`,
      });
    }
  }

  const valid = issues.every(issue => issue.severity !== 'error');
  return {valid, flow, issues};
}
