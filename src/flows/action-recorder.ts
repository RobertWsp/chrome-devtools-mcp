/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ToolDefinition} from '../tools/ToolDefinition.js';

import {isRecordable, normalizeAction} from './action-normalizer.js';
import type {FlowAction} from './flow-model.js';

/**
 * Buffers recordable browser actions for a single session (Observer). It is
 * always-on: every successful mutating tool call is appended, and the buffer is
 * later turned into a draft flow (by the LLM step in the host) or discarded on
 * session end / error, avoiding false positives.
 */
export class ActionRecorder {
  readonly #actions: FlowAction[] = [];
  #enabled = true;

  get size(): number {
    return this.#actions.length;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(value: boolean): void {
    this.#enabled = value;
  }

  /**
   * Records a successful tool invocation if it is a mutating browser action.
   * Read-only and session/flow tools are ignored. Only call this after the
   * tool succeeded, so failed actions never pollute the draft.
   */
  record(tool: ToolDefinition, params: Record<string, unknown>): void {
    if (!this.#enabled || !isRecordable(tool)) {
      return;
    }
    this.#actions.push(normalizeAction(tool.name, params));
  }

  /** Returns a copy of the buffered actions. */
  snapshot(): FlowAction[] {
    return this.#actions.map(action => ({
      tool: action.tool,
      params: {...action.params},
    }));
  }

  clear(): void {
    this.#actions.length = 0;
  }

  /**
   * Drops all but the last `count` actions. Used after an auto-save to keep
   * the start of the next journey (e.g. the navigation that opened a new
   * origin) while discarding what was already persisted.
   */
  retainTail(count: number): void {
    if (count <= 0) {
      this.#actions.length = 0;
      return;
    }
    if (count >= this.#actions.length) {
      return;
    }
    this.#actions.splice(0, this.#actions.length - count);
  }
}
