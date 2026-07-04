/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FlowAction} from './flow-model.js';
import {hostOf, navigationUrl, slugify} from './journey-actions.js';

/**
 * Decides when a recorded buffer represents a completed "journey" worth
 * persisting as a draft flow, so a useful recording is never lost even if the
 * model never explicitly calls op=save.
 *
 * Signals (either triggers a boundary):
 *  - a navigation to a NEW origin after some interaction happened (the prior
 *    journey is considered done), or
 *  - the buffer reaching {@link maxActionsPerJourney} actions.
 *
 * Pure + stateless-per-call: it inspects the buffered actions and returns a
 * decision. The caller owns persistence + buffer trimming, keeping this unit
 * trivially testable.
 */

/** Which boundary triggered the save. Drives how much of the buffer to keep. */
export type AutoSaveBoundary = 'origin' | 'size';

export interface AutoSaveDecision {
  /** Whether a draft should be persisted now. */
  save: boolean;
  /** Suggested flow name (kebab, unique-ish) when save is true. */
  suggestedName?: string;
  /** Structured boundary kind (SSoT for the caller's trim behavior). */
  boundary?: AutoSaveBoundary;
  /**
   * How many trailing actions to KEEP after saving. An origin boundary keeps
   * the navigation that starts the next journey (1); a size cap keeps none.
   */
  retainAfterSave?: number;
  /** Human hint describing why the boundary fired (for logs/UX only). */
  reason?: string;
}

export interface AutoSaverOptions {
  /** Force a boundary after this many buffered actions. Default 12. */
  maxActionsPerJourney?: number;
  /** Minimum actions before a new-origin navigation counts. Default 2. */
  minActionsForOriginBoundary?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const DEFAULT_MAX_ACTIONS = 12;
const DEFAULT_MIN_ACTIONS = 2;

/** Origin key for boundary detection: the host+scheme stub of a navigation. */
function originOf(action: FlowAction): string | undefined {
  return hostOf(action);
}

/**
 * Builds a human-meaningful slug from the FIRST navigation of the journey:
 * host + first meaningful path segment (e.g. `app-example-com-login`), so an
 * auto-saved draft reads as what it did rather than an opaque `journey`. Falls
 * back to `journey` only when no URL is available.
 */
function slugFromFirstNav(buffer: readonly FlowAction[]): string {
  for (const action of buffer) {
    const url = navigationUrl(action);
    if (url === undefined) {
      continue;
    }
    try {
      const u = new URL(url);
      const host = u.host.replace(/^www\./, '');
      // First two non-empty path segments give the page context (login, etc.).
      const pathPart = u.pathname
        .split('/')
        .filter(Boolean)
        .slice(0, 2)
        .join('-');
      const slug = slugify([host, pathPart].filter(Boolean).join('-'));
      if (slug) {
        return slug;
      }
    } catch {
      // non-URL (data:, about:) -> keep scanning
    }
  }
  return 'journey';
}

export class AutoSaver {
  readonly #maxActions: number;
  readonly #minForOrigin: number;
  readonly #now: () => number;

  constructor(options: AutoSaverOptions = {}) {
    this.#maxActions = options.maxActionsPerJourney ?? DEFAULT_MAX_ACTIONS;
    this.#minForOrigin =
      options.minActionsForOriginBoundary ?? DEFAULT_MIN_ACTIONS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Given the current buffer and the action just appended, decide whether the
   * prior journey (everything BEFORE the latest action) should be saved.
   *
   * Returns save=true when the latest action navigates to a new origin after
   * enough interaction, or when the buffer hit the size cap.
   */
  evaluate(buffer: readonly FlowAction[]): AutoSaveDecision {
    if (buffer.length === 0) {
      return {save: false};
    }

    // Size cap: the whole buffer is a journey. Keep nothing afterwards.
    if (buffer.length >= this.#maxActions) {
      return {
        save: true,
        boundary: 'size',
        retainAfterSave: 0,
        suggestedName: this.#name(buffer),
        reason: `reached ${this.#maxActions} actions`,
      };
    }

    // New-origin boundary: the LAST action navigated somewhere new and there
    // was meaningful prior interaction.
    const last = buffer[buffer.length - 1];
    const lastOrigin = originOf(last);
    if (lastOrigin && buffer.length - 1 >= this.#minForOrigin) {
      const priorOrigins = new Set<string>();
      for (let i = 0; i < buffer.length - 1; i++) {
        const o = originOf(buffer[i]);
        if (o) {
          priorOrigins.add(o);
        }
      }
      if (priorOrigins.size > 0 && !priorOrigins.has(lastOrigin)) {
        return {
          save: true,
          boundary: 'origin',
          // Keep the navigation that starts the next journey.
          retainAfterSave: 1,
          suggestedName: this.#name(buffer.slice(0, buffer.length - 1)),
          reason: `navigated to a new origin (${lastOrigin})`,
        };
      }
    }

    return {save: false};
  }

  #name(buffer: readonly FlowAction[]): string {
    // Compact, sortable date-time suffix (YYYYMMDD-HHMMSS) instead of an opaque
    // epoch-ms, so a list of auto-* drafts reads chronologically at a glance.
    const d = new Date(this.#now());
    const p = (n: number) => `${n}`.padStart(2, '0');
    const stamp =
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `auto-${slugFromFirstNav(buffer)}-${stamp}`;
  }
}
