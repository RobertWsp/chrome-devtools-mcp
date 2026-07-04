/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SerializedAXNode} from 'puppeteer-core';

import type {ToolDefinition} from '../tools/ToolDefinition.js';

import {
  type ElementTarget,
  TARGET_PARAM,
  targetFromAXNode,
} from './element-target.js';
import type {FlowAction} from './flow-model.js';

/**
 * Resolves an ephemeral snapshot uid to its accessibility node at record time,
 * so the normalizer can attach a durable {@link ElementTarget}. Injected by the
 * recorder (backed by `context.getAXNodeByUid`) to keep this module pure and
 * decoupled from McpContext.
 */
export type AXNodeLookup = (
  uid: string,
) => Pick<SerializedAXNode, 'role' | 'name' | 'value'> | undefined;

/**
 * Param keys that carry an ephemeral snapshot uid. Each is enriched with a
 * sibling durable target at record time so replay can re-resolve it. SSoT for
 * "which params are uid handles".
 */
export const UID_PARAM_KEYS = ['uid', 'from_uid', 'to_uid'] as const;

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
  lookupAXNode?: AXNodeLookup,
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
  if (lookupAXNode) {
    enrichWithTargets(clean, lookupAXNode);
  }
  return {tool: toolName, params: clean};
}

/**
 * Attaches a durable {@link ElementTarget} next to every ephemeral uid in a
 * params object, so the executor can re-resolve the element on replay. Handles
 * the flat uid params (`uid`/`from_uid`/`to_uid`) and the `fill_form.elements`
 * array (each entry carries its own uid). A target-per-uid is stored under a
 * parallel key so the raw uid stays for debugging and the AST round-trips.
 */
function enrichWithTargets(
  params: Record<string, unknown>,
  lookupAXNode: AXNodeLookup,
): void {
  for (const key of UID_PARAM_KEYS) {
    const uid = params[key];
    if (typeof uid === 'string') {
      const target = targetFromAXNode(lookupAXNode(uid));
      if (target) {
        params[`${targetKeyFor(key)}`] = target;
      }
    }
  }
  // fill_form: elements: [{uid, value}] -> attach a target to each entry.
  const elements = params.elements;
  if (Array.isArray(elements)) {
    params.elements = elements.map(el => {
      if (
        el &&
        typeof el === 'object' &&
        typeof (el as {uid?: unknown}).uid === 'string'
      ) {
        const entry = el as {uid: string; [k: string]: unknown};
        const target = targetFromAXNode(lookupAXNode(entry.uid));
        return target ? {...entry, [TARGET_PARAM]: target} : {...entry};
      }
      return el;
    });
  }
}

/**
 * The param key under which a uid param's durable target is stored. For the
 * primary `uid` this is `__target`; for the named handles it is suffixed so
 * `from_uid`/`to_uid` keep distinct targets.
 */
export function targetKeyFor(uidKey: string): string {
  return uidKey === 'uid' ? TARGET_PARAM : `${TARGET_PARAM}_${uidKey}`;
}

export type {ElementTarget};
