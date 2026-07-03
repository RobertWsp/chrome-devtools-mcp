/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  isRecordable,
  normalizeAction,
  recordableToolNames,
} from '../../src/flows/action-normalizer.js';
import {ActionRecorder} from '../../src/flows/action-recorder.js';
import type {ToolDefinition} from '../../src/tools/ToolDefinition.js';
import {tools} from '../../src/tools/tools.js';

/**
 * The curated subset the termness idle-nudge tracker arms on
 * (`core/quality/flow-nudge-tracker.ts`: RECORDABLE_CHROME_TOOL_NAMES).
 * Duplicated here as a literal so this repo can guard the cross-process
 * invariant without importing the separate termness package. If the termness
 * list changes, update this literal in the same PR.
 */
const TERMNESS_NUDGE_TOOLS = [
  'click',
  'click_at',
  'drag',
  'fill',
  'fill_form',
  'handle_dialog',
  'hover',
  'navigate_page',
  'new_page',
  'press_key',
  'resize_page',
  'upload_file',
];

function tool(name: string, readOnlyHint: boolean): ToolDefinition {
  return {
    name,
    description: '',
    annotations: {category: 'navigation', readOnlyHint},
    schema: {},
    handler: async () => {
      // no-op
    },
  } as unknown as ToolDefinition;
}

describe('recordableToolNames contract', () => {
  it('every termness nudge tool is recordable by this fork (subset invariant)', () => {
    const recordable = new Set(recordableToolNames(tools));
    const missing = TERMNESS_NUDGE_TOOLS.filter(name => !recordable.has(name));
    assert.deepStrictEqual(
      missing,
      [],
      `termness nudge tools not recordable here: ${missing.join(', ')}`,
    );
  });
});

describe('action-normalizer', () => {
  it('records only mutating browser tools', () => {
    assert.strictEqual(isRecordable(tool('click', false)), true);
    assert.strictEqual(isRecordable(tool('list_pages', true)), false);
    assert.strictEqual(isRecordable(tool('create_session', false)), false);
    assert.strictEqual(isRecordable(tool('flow', false)), false);
  });

  it('strips transport params and undefined values', () => {
    const action = normalizeAction('click', {
      sessionId: 'abc',
      uid: '1_2',
      background: undefined,
    });
    assert.deepStrictEqual(action, {tool: 'click', params: {uid: '1_2'}});
  });
});

describe('ActionRecorder', () => {
  it('buffers recordable actions and snapshots a copy', () => {
    const rec = new ActionRecorder();
    rec.record(tool('click', false), {sessionId: 's', uid: '1'});
    rec.record(tool('list_pages', true), {sessionId: 's'});
    rec.record(tool('navigate_page', false), {sessionId: 's', url: 'x'});

    assert.strictEqual(rec.size, 2);
    const snap = rec.snapshot();
    assert.deepStrictEqual(snap, [
      {tool: 'click', params: {uid: '1'}},
      {tool: 'navigate_page', params: {url: 'x'}},
    ]);
    // Snapshot is a copy.
    snap[0].params.uid = 'mutated';
    assert.strictEqual(rec.snapshot()[0].params.uid, '1');
  });

  it('honors enable/disable and clear', () => {
    const rec = new ActionRecorder();
    rec.setEnabled(false);
    rec.record(tool('click', false), {uid: '1'});
    assert.strictEqual(rec.size, 0);

    rec.setEnabled(true);
    rec.record(tool('click', false), {uid: '1'});
    assert.strictEqual(rec.size, 1);
    rec.clear();
    assert.strictEqual(rec.size, 0);
  });
});
