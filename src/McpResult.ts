/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CallToolResult} from './third_party/index.js';

/**
 * Single source of truth for building `tools/call` results from plain text.
 * Keeping construction in one place avoids the shape (`content`/`isError`)
 * being hand-assembled at every call site.
 */
export function textResult(text: string): CallToolResult {
  return {content: [{type: 'text', text}]};
}

/**
 * Builds an error result from any thrown value. Unwraps `Error` messages and
 * appends a nested `cause` message when present, mirroring how the browser
 * tool pipeline reports failures.
 */
export function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof Error) {
    text = err.message;
    if (err.cause instanceof Error) {
      text += `\nCause: ${err.cause.message}`;
    }
  } else {
    text = String(err);
  }
  return {content: [{type: 'text', text}], isError: true};
}
