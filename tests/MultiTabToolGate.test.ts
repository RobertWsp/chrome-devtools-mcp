/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {MultiTabToolGate} from '../src/MultiTabToolGate.js';
import type {RegisteredTool} from '../src/third_party/index.js';

function fakeTool(): RegisteredTool & {
  enabledCount: number;
  disabledCount: number;
} {
  const tool = {
    enabled: false,
    enabledCount: 0,
    disabledCount: 0,
    enable() {
      this.enabled = true;
      this.enabledCount++;
    },
    disable() {
      this.enabled = false;
      this.disabledCount++;
    },
  };
  return tool as unknown as RegisteredTool & {
    enabledCount: number;
    disabledCount: number;
  };
}

describe('MultiTabToolGate', () => {
  it('registers tools disabled', () => {
    const gate = new MultiTabToolGate();
    const tool = fakeTool();
    gate.register('switch_tab', tool);
    assert.strictEqual(tool.enabled, false);
    assert.strictEqual(gate.enabled, false);
  });

  it('enables tools when a session becomes multi-tab', () => {
    const gate = new MultiTabToolGate();
    const tool = fakeTool();
    gate.register('switch_tab', tool);

    gate.sync([{hasMultipleTabs: () => true}]);
    assert.strictEqual(tool.enabled, true);
    assert.strictEqual(gate.enabled, true);
  });

  it('is idempotent: no repeated toggles while state is unchanged', () => {
    const gate = new MultiTabToolGate();
    const tool = fakeTool();
    gate.register('switch_tab', tool);
    // register() disabled once already.
    assert.strictEqual(tool.disabledCount, 1);

    gate.sync([{hasMultipleTabs: () => true}]);
    gate.sync([{hasMultipleTabs: () => true}]);
    assert.strictEqual(tool.enabledCount, 1, 'enable emitted only once');

    gate.sync([{hasMultipleTabs: () => false}]);
    gate.sync([{hasMultipleTabs: () => false}]);
    assert.strictEqual(tool.disabledCount, 2, 'disable emitted only once more');
  });

  it('treats any multi-tab session as sufficient', () => {
    const gate = new MultiTabToolGate();
    const tool = fakeTool();
    gate.register('switch_tab', tool);

    gate.sync([
      {hasMultipleTabs: () => false},
      {hasMultipleTabs: () => true},
      {hasMultipleTabs: () => false},
    ]);
    assert.strictEqual(gate.enabled, true);
  });

  it('handles no sessions as single-tab (disabled)', () => {
    const gate = new MultiTabToolGate();
    const tool = fakeTool();
    gate.register('switch_tab', tool);
    gate.sync([{hasMultipleTabs: () => true}]);
    gate.sync([]);
    assert.strictEqual(gate.enabled, false);
    assert.strictEqual(tool.enabled, false);
  });
});
