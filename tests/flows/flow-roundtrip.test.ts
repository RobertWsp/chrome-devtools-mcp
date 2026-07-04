/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {generateFlowSource} from '../../src/flows/codegen.js';
import type {Flow} from '../../src/flows/flow-model.js';
import {envRef} from '../../src/flows/flow-model.js';
import {parseFlowSource} from '../../src/flows/flow-parser.js';

function sample(): Flow {
  return {
    name: 'login',
    description: 'Logs in and lands on the dashboard',
    env: ['LOGIN_PASSWORD'],
    steps: [
      {
        name: 'open',
        description: 'Navigate to the app',
        actions: [{tool: 'navigate_page', params: {url: 'https://app.test'}}],
      },
      {
        name: 'authenticate',
        actions: [
          {tool: 'fill', params: {uid: '1_2', value: 'user@test.dev'}},
          {
            tool: 'fill',
            params: {uid: '1_3', value: envRef('LOGIN_PASSWORD')},
          },
          {tool: 'click', params: {uid: '1_4', dblClick: false, timeout: 5000}},
        ],
      },
    ],
  };
}

describe('flow codegen <-> parser roundtrip', () => {
  it('regenerates an equivalent AST', () => {
    const flow = sample();
    const source = generateFlowSource(flow);
    const parsed = parseFlowSource(source);

    // env order may be normalized; compare as sets and structurally otherwise.
    assert.strictEqual(parsed.name, flow.name);
    assert.strictEqual(parsed.description, flow.description);
    assert.deepStrictEqual(parsed.steps, flow.steps);
    assert.deepStrictEqual([...parsed.env].sort(), [...flow.env].sort());
  });

  it('preserves env references as markers, not literals', () => {
    const source = generateFlowSource(sample());
    assert.match(source, /env\("LOGIN_PASSWORD"\)/);
    assert.doesNotMatch(source, /value: "LOGIN_PASSWORD"/);

    const parsed = parseFlowSource(source);
    const pwAction = parsed.steps[1].actions[1];
    assert.deepStrictEqual(pwAction.params.value, envRef('LOGIN_PASSWORD'));
  });

  it('handles steps without descriptions and empty params', () => {
    const flow: Flow = {
      name: 'simple',
      description: '',
      env: [],
      steps: [
        {
          name: 'reload',
          actions: [{tool: 'navigate_page', params: {type: 'reload'}}],
        },
        {name: 'snapshot', actions: [{tool: 'take_snapshot', params: {}}]},
      ],
    };
    const parsed = parseFlowSource(generateFlowSource(flow));
    assert.deepStrictEqual(parsed.steps, flow.steps);
  });

  it('round-trips a step precondition via ctx.require', () => {
    const flow: Flow = {
      name: 'guarded',
      description: '',
      env: [],
      steps: [
        {
          name: 'open',
          actions: [{tool: 'navigate_page', params: {url: 'https://app.test'}}],
        },
        {
          name: 'fill-form',
          precondition: {selector: '#login-form', timeoutMs: 8000},
          actions: [{tool: 'fill', params: {uid: '1', value: 'x'}}],
        },
        {
          name: 'submit',
          precondition: {selector: 'button[type=submit]'},
          actions: [{tool: 'click', params: {uid: '2'}}],
        },
      ],
    };
    const source = generateFlowSource(flow);
    // Precondition emits a readable ctx.require as the first step statement.
    assert.match(source, /ctx\.require\("#login-form", 8000\)/);
    assert.match(source, /ctx\.require\("button\[type=submit\]"\)/);
    const parsed = parseFlowSource(source);
    assert.deepStrictEqual(parsed.steps, flow.steps);
  });

  it('throws on a source without defineFlow', () => {
    assert.throws(
      () => parseFlowSource('export const x = 1;'),
      /No defineFlow/,
    );
  });
});
