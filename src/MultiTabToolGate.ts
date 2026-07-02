/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {RegisteredTool} from './third_party/index.js';

/**
 * Minimal contract a session must satisfy for the gate to decide visibility.
 * Depending on this instead of the concrete SessionManager keeps the gate
 * decoupled and trivially unit-testable.
 */
export interface MultiTabProbe {
  hasMultipleTabs(): boolean;
}

/**
 * Controls on-demand visibility of tab-targeting tools (e.g. `switch_tab`).
 * The tools are always registered but start disabled; the gate enables them
 * only while at least one session has multiple tabs, flipping in one place so
 * `notifications/tools/list_changed` is emitted at most once per transition.
 */
export class MultiTabToolGate {
  readonly #tools = new Map<string, RegisteredTool>();
  #enabled = false;

  /** Registers a tool as multi-tab gated and disables it until needed. */
  register(name: string, tool: RegisteredTool): void {
    tool.disable();
    this.#tools.set(name, tool);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Syncs tool visibility to whether any probed session is multi-tab. No-op
   * (and no notification) when the state is unchanged.
   */
  sync(sessions: Iterable<MultiTabProbe>): void {
    let anyMultiTab = false;
    for (const session of sessions) {
      if (session.hasMultipleTabs()) {
        anyMultiTab = true;
        break;
      }
    }
    if (anyMultiTab === this.#enabled) {
      return;
    }
    this.#enabled = anyMultiTab;
    for (const tool of this.#tools.values()) {
      if (anyMultiTab) {
        tool.enable();
      } else {
        tool.disable();
      }
    }
  }
}
