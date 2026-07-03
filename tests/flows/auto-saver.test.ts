/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {AutoSaver} from '../../src/flows/auto-saver.js';
import type {FlowAction} from '../../src/flows/flow-model.js';

function nav(url: string): FlowAction {
  return {tool: 'navigate_page', params: {url}};
}
function click(uid: string): FlowAction {
  return {tool: 'click', params: {uid}};
}

describe('AutoSaver', () => {
  it('does not save an empty buffer', () => {
    const s = new AutoSaver();
    assert.strictEqual(s.evaluate([]).save, false);
  });

  it('does not save a short single-origin journey', () => {
    const s = new AutoSaver();
    const d = s.evaluate([nav('https://a.test/1'), click('1'), click('2')]);
    assert.strictEqual(d.save, false);
  });

  it('saves when the buffer hits the action cap', () => {
    const s = new AutoSaver({maxActionsPerJourney: 4, now: () => 111});
    const d = s.evaluate([
      nav('https://a.test'),
      click('1'),
      click('2'),
      click('3'),
    ]);
    assert.strictEqual(d.save, true);
    assert.strictEqual(d.boundary, 'size');
    assert.strictEqual(d.retainAfterSave, 0);
    assert.match(d.reason ?? '', /reached 4 actions/);
    assert.match(d.suggestedName ?? '', /^auto-.*-111$/);
  });

  it('saves the prior journey when navigating to a new origin', () => {
    const s = new AutoSaver({now: () => 222});
    const buffer = [
      nav('https://shop.test/login'),
      click('1'),
      click('2'),
      nav('https://other.test/home'),
    ];
    const d = s.evaluate(buffer);
    assert.strictEqual(d.save, true);
    assert.strictEqual(d.boundary, 'origin');
    assert.strictEqual(d.retainAfterSave, 1);
    assert.match(d.reason ?? '', /new origin \(other\.test\)/);
    assert.match(d.suggestedName ?? '', /shop-test/);
  });

  it('does not fire on a same-origin navigation', () => {
    const s = new AutoSaver();
    const buffer = [
      nav('https://a.test/1'),
      click('1'),
      click('2'),
      nav('https://a.test/2'),
    ];
    assert.strictEqual(s.evaluate(buffer).save, false);
  });

  it('does not fire on a new origin without enough prior interaction', () => {
    const s = new AutoSaver({minActionsForOriginBoundary: 3});
    const buffer = [nav('https://a.test'), nav('https://b.test')];
    assert.strictEqual(s.evaluate(buffer).save, false);
  });
});
