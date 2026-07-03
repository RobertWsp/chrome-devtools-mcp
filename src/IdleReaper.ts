/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';

/**
 * Minimal contract the reaper drives. Depending on this instead of the concrete
 * SessionManager keeps the reaper decoupled and unit-testable with a fake.
 */
export interface ReapableSessions {
  /** Close non-selected tabs idle beyond `tabIdleMs`. Returns tabs closed. */
  closeIdleTabsForAll(tabIdleMs: number): Promise<number>;
  /** Close sessions idle beyond `sessionIdleMs`. Returns sessions closed. */
  reapIdleSessions(sessionIdleMs: number): Promise<number>;
}

export interface IdleReaperOptions {
  /** Idle time before a non-selected tab is closed. */
  tabIdleMs: number;
  /** Idle time before a whole session (browser) is closed. */
  sessionIdleMs: number;
  /** How often the reaper runs. Defaults to min(tabIdle, sessionIdle)/2. */
  intervalMs?: number;
}

/**
 * Periodically reclaims resources without tearing down active work: first it
 * closes idle background tabs (cheap, non-disruptive), then it closes sessions
 * that have been fully idle for longer. This is the single source of truth for
 * idle-driven cleanup on the server side, replacing the host broker's blunt
 * "kill the whole shared subprocess" behavior.
 *
 * Design: a single unref'd interval (Timer). Ticks are serialized (a slow tick
 * never overlaps the next) and never throw out of the callback, so the reaper
 * can never crash the process.
 */
export class IdleReaper {
  readonly #sessions: ReapableSessions;
  readonly #tabIdleMs: number;
  readonly #sessionIdleMs: number;
  readonly #intervalMs: number;
  #timer?: NodeJS.Timeout;
  #running = false;

  constructor(sessions: ReapableSessions, options: IdleReaperOptions) {
    this.#sessions = sessions;
    this.#tabIdleMs = options.tabIdleMs;
    this.#sessionIdleMs = options.sessionIdleMs;
    // Run often enough to reap close to the threshold, but never busier than
    // every second. Bounded by the smallest configured threshold so a short
    // threshold still gets a timely pass; capped at 30s so a long threshold
    // doesn't spin.
    const smallest = Math.min(this.#tabIdleMs, this.#sessionIdleMs);
    this.#intervalMs =
      options.intervalMs ?? Math.min(30_000, Math.max(1_000, smallest / 2));
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    // Never keep the process alive just for the reaper.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Runs one reap pass. Public for tests and deterministic invocation. Guards
   * against overlap and swallows errors so a failure never escapes.
   */
  async tick(): Promise<void> {
    if (this.#running) {
      return;
    }
    this.#running = true;
    try {
      const tabs = await this.#sessions.closeIdleTabsForAll(this.#tabIdleMs);
      if (tabs > 0) {
        logger(`IdleReaper closed ${tabs} idle tab(s)`);
      }
      const sessions = await this.#sessions.reapIdleSessions(
        this.#sessionIdleMs,
      );
      if (sessions > 0) {
        logger(`IdleReaper closed ${sessions} idle session(s)`);
      }
    } catch (err) {
      logger('IdleReaper tick error:', err);
    } finally {
      this.#running = false;
    }
  }
}
