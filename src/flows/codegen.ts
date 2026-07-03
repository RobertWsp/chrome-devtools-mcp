/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Flow, FlowAction} from './flow-model.js';
import {isEnvRef} from './flow-model.js';

/**
 * Serializes a {@link Flow} into a Playwright-style `.cdp.ts` module. The file
 * is human-readable and reviewable in git, yet structured deterministically so
 * {@link parseFlowSource} can recover the exact AST (the flow model stays the
 * single source of truth; this file is a projection of it).
 *
 * Secrets appear as `env("VAR")` calls, never as literals.
 */
export function generateFlowSource(flow: Flow): string {
  const lines: string[] = [];
  lines.push(`// Auto-generated CDP flow. Edit steps/actions, then run`);
  lines.push(`// \`flow\` op=validate to re-check before committing.`);
  lines.push(`// Secrets are referenced via env("VAR") and live in .env.`);
  lines.push(``);
  lines.push(`import {defineFlow, env, type FlowContext} from "./runtime.js";`);
  lines.push(``);
  lines.push(`export default defineFlow({`);
  lines.push(`  name: ${JSON.stringify(flow.name)},`);
  lines.push(`  description: ${JSON.stringify(flow.description)},`);
  lines.push(`  env: ${JSON.stringify(flow.env)},`);
  if (flow.createdAt) {
    lines.push(`  createdAt: ${JSON.stringify(flow.createdAt)},`);
  }
  if (flow.updatedAt) {
    lines.push(`  updatedAt: ${JSON.stringify(flow.updatedAt)},`);
  }
  lines.push(`  steps: async (ctx: FlowContext) => {`);
  for (const step of flow.steps) {
    lines.push(``);
    const desc = step.description
      ? `, ${JSON.stringify(step.description)}`
      : '';
    lines.push(
      `    await ctx.step(${JSON.stringify(step.name)}${desc}, async () => {`,
    );
    for (const action of step.actions) {
      lines.push(`      await ctx.run(${renderAction(action)});`);
    }
    lines.push(`    });`);
  }
  lines.push(`  },`);
  lines.push(`});`);
  lines.push(``);
  return lines.join('\n');
}

function renderAction(action: FlowAction): string {
  return `${JSON.stringify(action.tool)}, ${renderParams(action.params)}`;
}

function renderParams(params: FlowAction['params']): string {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return '{}';
  }
  const parts = entries.map(
    ([key, value]) => `${JSON.stringify(key)}: ${renderValue(value)}`,
  );
  return `{${parts.join(', ')}}`;
}

function renderValue(value: unknown): string {
  if (isEnvRef(value)) {
    return `env(${JSON.stringify(value.__env)})`;
  }
  return JSON.stringify(value);
}
