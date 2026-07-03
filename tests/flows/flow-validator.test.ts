/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {Flow} from '../../src/flows/flow-model.js';
import {envRef} from '../../src/flows/flow-model.js';
import {validateFlow} from '../../src/flows/flow-validator.js';

const knownTools = new Set(['navigate_page', 'click', 'fill']);

function baseFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    name: 'login',
    description: '',
    env: [],
    steps: [
      {name: 'open', actions: [{tool: 'navigate_page', params: {url: 'x'}}]},
    ],
    ...overrides,
  };
}

describe('flow-validator', () => {
  it('accepts a well-formed flow', () => {
    const result = validateFlow(baseFlow(), {knownTools});
    assert.strictEqual(result.valid, true);
  });

  it('rejects unknown tools', () => {
    const result = validateFlow(
      baseFlow({
        steps: [{name: 's', actions: [{tool: 'teleport', params: {}}]}],
      }),
      {knownTools},
    );
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.issues.some(i => /unknown tool "teleport"/.test(i.message)),
    );
  });

  it('flags leaked secrets as errors', () => {
    const result = validateFlow(
      baseFlow({
        steps: [
          {name: 's', actions: [{tool: 'fill', params: {password: 'raw'}}]},
        ],
      }),
      {knownTools},
    );
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some(i => /plaintext secret/.test(i.message)));
  });

  it('warns on oversized timeouts', () => {
    const result = validateFlow(
      baseFlow({
        steps: [
          {
            name: 's',
            actions: [{tool: 'click', params: {uid: '1', timeout: 999999}}],
          },
        ],
      }),
      {knownTools, maxTimeoutMs: 60000},
    );
    assert.ok(
      result.issues.some(
        i => i.severity === 'warning' && /timeout/.test(i.message),
      ),
    );
  });

  it('warns when env ref is undeclared', () => {
    const result = validateFlow(
      baseFlow({
        env: [],
        steps: [
          {
            name: 's',
            actions: [{tool: 'fill', params: {value: envRef('TOKEN')}}],
          },
        ],
      }),
      {knownTools},
    );
    assert.ok(result.issues.some(i => /not declared/.test(i.message)));
  });
});
