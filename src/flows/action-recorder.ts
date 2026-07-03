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
}
