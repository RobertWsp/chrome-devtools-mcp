/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {Flow} from '../../src/flows/flow-model.js';
import {envRef, isEnvRef} from '../../src/flows/flow-model.js';
import {
  extractSecrets,
  findLeakedSecrets,
} from '../../src/flows/secret-scanner.js';

function flowWith(params: Record<string, unknown>): Flow {
  return {
    name: 'login',
    description: '',
    env: [],
    steps: [{name: 'auth', actions: [{tool: 'fill', params}]}],
  };
}

describe('secret-scanner', () => {
  it('extracts secret-keyed params into env refs', () => {
    const {flow, secrets} = extractSecrets(
      flowWith({uid: '1_2', password: 'hunter2'}),
    );
    assert.strictEqual(secrets.length, 1);
    assert.strictEqual(secrets[0].value, 'hunter2');
    assert.match(secrets[0].envVar, /^LOGIN_PASSWORD/);

    const stored = flow.steps[0].actions[0].params;
    assert.ok(isEnvRef(stored.password));
    assert.strictEqual(stored.uid, '1_2');
    assert.ok(flow.env.includes(secrets[0].envVar));
  });

  it('detects secret-looking values under non-secret keys', () => {
    const {secrets} = extractSecrets(
      flowWith({value: 'Bearer abcdefgh12345678'}),
    );
    assert.strictEqual(secrets.length, 1);
  });

  it('reuses one env var for identical repeated values', () => {
    const flow: Flow = {
      name: 'login',
      description: '',
      env: [],
      steps: [
        {
          name: 'a',
          actions: [
            {tool: 'fill', params: {password: 'same'}},
            {tool: 'fill', params: {password: 'same'}},
          ],
        },
      ],
    };
    const {secrets} = extractSecrets(flow);
    assert.strictEqual(secrets.length, 1);
  });

  it('leaves existing env refs untouched', () => {
    const {secrets} = extractSecrets(flowWith({password: envRef('PRESET')}));
    assert.strictEqual(secrets.length, 0);
  });

  it('flags leaked plaintext secrets', () => {
    const leaks = findLeakedSecrets(flowWith({password: 'plaintext'}));
    assert.strictEqual(leaks.length, 1);
    assert.match(leaks[0], /auth > fill\.password/);
  });

  it('does not flag env-referenced secrets as leaks', () => {
    const leaks = findLeakedSecrets(flowWith({password: envRef('X')}));
    assert.deepStrictEqual(leaks, []);
  });
});
