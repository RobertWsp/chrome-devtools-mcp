/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ToolDefinition} from '../tools/ToolDefinition.js';

import type {FlowAction} from './flow-model.js';

/**
 * Tools that must never be recorded into a flow: session lifecycle and the
 * flow tool itself would make a replay self-referential or environment
 * specific. Read-only tools are filtered separately via `readOnlyHint`.
 */
const NON_RECORDABLE_TOOLS = new Set<string>([
  'create_session',
  'list_sessions',
  'close_session',
  'flow',
]);

/**
 * Parameters that are transport/session concerns, not part of the reproducible
 * action, so they are stripped before storing.
 */
const TRANSPORT_PARAMS = new Set<string>(['sessionId']);

/**
 * Decides whether a tool invocation should be captured by the recorder. Only
 * state-mutating browser actions (readOnlyHint === false) that are not session
 * or flow management are recordable.
 */
export function isRecordable(tool: ToolDefinition): boolean {
  if (NON_RECORDABLE_TOOLS.has(tool.name)) {
    return false;
  }
  return tool.annotations.readOnlyHint === false;
}

/**
 * Live source of truth for the recordable tool names, derived from the actual
 * tool definitions. Used by the contract test that guards the termness nudge
 * mirror against drift.
 */
export function recordableToolNames(
  tools: readonly ToolDefinition[],
): string[] {
  return tools
    .filter(isRecordable)
    .map(tool => tool.name)
    .sort();
}

/**
 * Converts a raw tool invocation into a storable {@link FlowAction}, dropping
 * transport-only params. Secret extraction happens later in the scanner so
 * this stays a pure structural transform.
 */
export function normalizeAction(
  toolName: string,
  params: Record<string, unknown>,
): FlowAction {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (TRANSPORT_PARAMS.has(key)) {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    clean[key] = value;
  }
  return {tool: toolName, params: clean};
}
