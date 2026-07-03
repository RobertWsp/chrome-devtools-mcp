/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FlowAction} from './flow-model.js';

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

export interface AutoSaveDecision {
  /** Whether a draft should be persisted now. */
  save: boolean;
  /** Suggested flow name (kebab, unique-ish) when save is true. */
  suggestedName?: string;
  /** Human hint describing why the boundary fired. */
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

function originOf(action: FlowAction): string | undefined {
  if (action.tool !== 'navigate_page' && action.tool !== 'new_page') {
    return undefined;
  }
  const url = action.params.url;
  if (typeof url !== 'string') {
    return undefined;
  }
  try {
    const u = new URL(url);
    // data: URLs have no host; use the scheme so distinct pages still separate.
    return u.host || `${u.protocol}${u.pathname.slice(0, 24)}`;
  } catch {
    return undefined;
  }
}

function slugFromOrigin(origin: string | undefined): string {
  const base = (origin ?? 'journey')
    .replace(/^https?:/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 32);
  return base || 'journey';
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

    // Size cap: the whole buffer is a journey.
    if (buffer.length >= this.#maxActions) {
      return {
        save: true,
        suggestedName: this.#name(originOf(buffer[0])),
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
          suggestedName: this.#name([...priorOrigins][0]),
          reason: `navigated to a new origin (${lastOrigin})`,
        };
      }
    }

    return {save: false};
  }

  #name(origin: string | undefined): string {
    return `auto-${slugFromOrigin(origin)}-${this.#now()}`;
  }
}
