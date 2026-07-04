/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FlowAction} from './flow-model.js';

/**
 * Shared vocabulary for reasoning about a recorded browser journey.
 *
 * Both the auto-saver (deciding journey boundaries + naming) and the
 * journey-summarizer (segmenting + describing) need the SAME notions of "what
 * starts a new page", "which host was visited", and "how a label becomes a
 * file-safe slug". These lived duplicated in both modules and had already
 * drifted (one stripped `www.`, the other didn't; two different slug length
 * caps). This leaf is the single source of truth so they can't diverge.
 *
 * Pure, no side effects, only depends on the FlowAction model.
 */

/** Tools whose invocation opens/loads a page, i.e. starts a journey phase. */
export const NAVIGATION_TOOLS: ReadonlySet<string> = new Set([
  'navigate_page',
  'new_page',
]);

/** True when the action navigates to a page (the natural phase boundary). */
export function isNavigation(action: FlowAction): boolean {
  return NAVIGATION_TOOLS.has(action.tool);
}

/** The `url` param of a navigation action, or undefined. */
export function navigationUrl(action: FlowAction): string | undefined {
  if (!isNavigation(action)) {
    return undefined;
  }
  const url = action.params.url;
  return typeof url === 'string' ? url : undefined;
}

/**
 * The host a navigation action targets, `www.`-stripped. For URLs without a
 * host (`data:`, `about:`) returns a scheme+path stub so distinct pages still
 * separate. Undefined when the action is not a navigation or the URL is unusable.
 */
export function hostOf(action: FlowAction): string | undefined {
  const url = navigationUrl(action);
  if (url === undefined) {
    return undefined;
  }
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    return host || `${u.protocol}${u.pathname.slice(0, 24)}`;
  } catch {
    return undefined;
  }
}

/**
 * A file-safe kebab slug: lowercased, non-alphanumerics collapsed to `-`,
 * trimmed, capped. SSoT for how a human label becomes part of a flow file name.
 */
export function slugify(value: string, maxLength = 40): string {
  return value
    .replace(/^https?:/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, maxLength);
}
