/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reserved tool-arg key carrying the caller's stable identity. Injected by the
 * host (termness broker) so this shared subprocess can scope each browser
 * session to the pi session that created it. It is transport-level: stripped
 * before a tool handler runs and never surfaced to the model.
 */
export const OWNER_PARAM = '__mcpClientId';

/**
 * Splits a params object into the owner id (if present) and the params with the
 * reserved key removed, so tool handlers never see it. Returns `undefined`
 * owner for legacy callers that don't send one.
 */
export function extractOwner(params: Record<string, unknown>): {
  owner: string | undefined;
  rest: Record<string, unknown>;
} {
  if (!(OWNER_PARAM in params)) {
    return {owner: undefined, rest: params};
  }
  const {[OWNER_PARAM]: raw, ...rest} = params;
  const owner = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  return {owner, rest};
}
