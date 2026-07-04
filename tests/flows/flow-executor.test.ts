/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {FlowExecutor} from '../../src/flows/flow-executor.js';
import type {Flow} from '../../src/flows/flow-model.js';
import {envRef} from '../../src/flows/flow-model.js';
import type {Context, ToolDefinition} from '../../src/tools/ToolDefinition.js';

interface Call {
  tool: string;
  params: Record<string, unknown>;
}

function makeTool(
  name: string,
  impl: (params: Record<string, unknown>) => Promise<void>,
): ToolDefinition {
  return {
    name,
    description: '',
    annotations: {category: 'navigation', readOnlyHint: false},
    schema: {},
    handler: async (request: {params: Record<string, unknown>}) =>
      impl(request.params),
  } as unknown as ToolDefinition;
}

const context = {} as Context;

describe('FlowExecutor', () => {
  it('runs all steps and records pass status', async () => {
    const calls: Call[] = [];
    const tool = makeTool('click', async params => {
      calls.push({tool: 'click', params});
    });
    const executor = new FlowExecutor({
      getTool: n => (n === 'click' ? tool : undefined),
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {name: 'a', actions: [{tool: 'click', params: {uid: '1'}}]},
        {name: 'b', actions: [{tool: 'click', params: {uid: '2'}}]},
      ],
    };
    const result = await executor.run(flow, context);
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.failedStepIndex, -1);
    assert.strictEqual(calls.length, 2);
  });

  it('stops at the first failing step and reports it', async () => {
    const tool = makeTool('click', async params => {
      if (params.uid === '2') {
        throw new Error('element not found');
      }
    });
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {name: 'a', actions: [{tool: 'click', params: {uid: '1'}}]},
        {name: 'b', actions: [{tool: 'click', params: {uid: '2'}}]},
        {name: 'c', actions: [{tool: 'click', params: {uid: '3'}}]},
      ],
    };
    const result = await executor.run(flow, context);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStepIndex, 1);
    assert.strictEqual(result.steps[1].status, 'failed');
    assert.strictEqual(result.steps[1].failedAction, 'click');
    assert.match(result.steps[1].error ?? '', /element not found/);
    // The full ledger is reported: the step AFTER the failure is 'skipped'
    // (never run) so the reader sees the whole flow and where it stopped.
    assert.strictEqual(result.steps.length, 3);
    assert.strictEqual(result.steps[2].status, 'skipped');
    assert.strictEqual(result.steps[2].name, 'c');
    assert.strictEqual(result.steps[2].actionsRun, 0);
  });

  it('resolves env refs from the provided getEnv', async () => {
    let seen: unknown;
    const tool = makeTool('fill', async params => {
      seen = params.value;
    });
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: name => (name === 'PW' ? 'secret-value' : undefined),
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: ['PW'],
      steps: [
        {name: 'a', actions: [{tool: 'fill', params: {value: envRef('PW')}}]},
      ],
    };
    const result = await executor.run(flow, context);
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(seen, 'secret-value');
  });

  it('fails when an env ref is missing', async () => {
    const tool = makeTool('fill', async () => {
      // no-op; the executor should fail before invoking it
    });
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: ['PW'],
      steps: [
        {name: 'a', actions: [{tool: 'fill', params: {value: envRef('PW')}}]},
      ],
    };
    const result = await executor.run(flow, context);
    assert.strictEqual(result.status, 'failed');
    assert.match(result.steps[0].error ?? '', /Missing environment variable/);
  });

  it('stopAtStep halts replay after the named step', async () => {
    const calls: Call[] = [];
    const tool = makeTool('click', async params => {
      calls.push({tool: 'click', params});
    });
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {name: 'a', actions: [{tool: 'click', params: {uid: '1'}}]},
        {name: 'b', actions: [{tool: 'click', params: {uid: '2'}}]},
      ],
    };
    const result = await executor.run(flow, context, {stopAtStep: 'a'});
    assert.strictEqual(result.steps.length, 1);
    assert.strictEqual(calls.length, 1);
  });

  it('startAtStep resumes replay at the named step (earlier steps skipped)', async () => {
    const calls: Call[] = [];
    const tool = makeTool('click', async params => {
      calls.push({tool: 'click', params});
    });
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {name: 'a', actions: [{tool: 'click', params: {uid: '1'}}]},
        {name: 'b', actions: [{tool: 'click', params: {uid: '2'}}]},
        {name: 'c', actions: [{tool: 'click', params: {uid: '3'}}]},
      ],
    };
    const result = await executor.run(flow, context, {startAtStep: 'b'});
    // Only b and c ran; a was trimmed off the front.
    assert.deepStrictEqual(
      result.steps.map(s => s.name),
      ['b', 'c'],
    );
    assert.deepStrictEqual(
      calls.map(c => c.params.uid),
      ['2', '3'],
    );
  });

  it('start+stop replays a CONTIGUOUS range without skipping middle steps', async () => {
    const calls: Call[] = [];
    const tool = makeTool('click', async params => {
      calls.push({tool: 'click', params});
    });
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {name: 'a', actions: [{tool: 'click', params: {uid: '1'}}]},
        {name: 'b', actions: [{tool: 'click', params: {uid: '2'}}]},
        {name: 'c', actions: [{tool: 'click', params: {uid: '3'}}]},
        {name: 'd', actions: [{tool: 'click', params: {uid: '4'}}]},
      ],
    };
    const result = await executor.run(flow, context, {
      startAtStep: 'b',
      stopAtStep: 'c',
    });
    assert.deepStrictEqual(
      result.steps.map(s => s.name),
      ['b', 'c'],
    );
  });

  it('throws on an unknown start/stop step name (never silently runs all)', async () => {
    const tool = makeTool('click', async () => {
      /* no-op */
    });
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [{name: 'a', actions: [{tool: 'click', params: {}}]}],
    };
    await assert.rejects(
      () => executor.run(flow, context, {startAtStep: 'nope'}),
      /is not a step of flow/,
    );
    await assert.rejects(
      () => executor.run(flow, context, {startAtStep: 'a', stopAtStep: 'nope'}),
      /is not a step of flow/,
    );
  });

  it('checks a step precondition and FAILS (never skips) when unmet', async () => {
    const calls: Call[] = [];
    const tool = makeTool('click', async params => {
      calls.push({tool: 'click', params});
    });
    // Fake page whose waitForSelector rejects (element absent).
    const pageMissing = {
      waitForSelector: async () => {
        throw new Error('timeout');
      },
      url: () => 'https://example.test/',
    };
    const ctx = {
      getSelectedPage: () => pageMissing,
    } as unknown as Context;
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {
          name: 'fill-form',
          precondition: {selector: '#login', timeoutMs: 10},
          actions: [{tool: 'click', params: {uid: '1'}}],
        },
      ],
    };
    const result = await executor.run(flow, ctx);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.steps[0].failedAction, 'precondition');
    assert.match(result.steps[0].error ?? '', /precondition not met/);
    // The step's actions never ran.
    assert.strictEqual(calls.length, 0);
  });

  it('runs a step whose precondition IS met', async () => {
    const calls: Call[] = [];
    const tool = makeTool('click', async params => {
      calls.push({tool: 'click', params});
    });
    const pagePresent = {
      waitForSelector: async () => ({}),
      url: () => 'https://example.test/',
    };
    const ctx = {
      getSelectedPage: () => pagePresent,
    } as unknown as Context;
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {
          name: 'fill-form',
          precondition: {selector: '#login'},
          actions: [{tool: 'click', params: {uid: '1'}}],
        },
      ],
    };
    const result = await executor.run(flow, ctx);
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(calls.length, 1);
  });

  it('re-resolves a durable target to a FRESH uid on replay', async () => {
    const calls: Call[] = [];
    const tool = makeTool('click', async params => {
      calls.push({tool: 'click', params});
    });
    let snapshots = 0;
    const ctx = {
      createTextSnapshot: async () => {
        snapshots++;
      },
      // The recorded uid was 1_5; the live snapshot exposes 42_9 for the same
      // element (role+name). The executor must rewrite the uid.
      resolveUidByTarget: (t: {role: string; name?: string}) =>
        t.role === 'button' && t.name === 'Sign in' ? '42_9' : undefined,
    } as unknown as Context;
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {
          name: 'submit',
          actions: [
            {
              tool: 'click',
              params: {uid: '1_5', __target: {role: 'button', name: 'Sign in'}},
            },
          ],
        },
      ],
    };
    const result = await executor.run(flow, ctx);
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(
      snapshots,
      1,
      'a fresh snapshot is captured before resolving',
    );
    // The handler received the FRESH uid, and the target marker was stripped.
    assert.strictEqual(calls[0].params.uid, '42_9');
    assert.strictEqual(calls[0].params.__target, undefined);
  });

  it('FAILS the step when a durable target no longer matches the page', async () => {
    const calls: Call[] = [];
    const tool = makeTool('click', async params => {
      calls.push({tool: 'click', params});
    });
    const ctx = {
      createTextSnapshot: async () => {
        /* no-op */
      },
      resolveUidByTarget: () => undefined, // element gone / structure changed
    } as unknown as Context;
    const executor = new FlowExecutor({
      getTool: () => tool,
      getEnv: () => undefined,
    });
    const flow: Flow = {
      name: 'f',
      description: '',
      env: [],
      steps: [
        {
          name: 'submit',
          actions: [
            {
              tool: 'click',
              params: {uid: '1_5', __target: {role: 'button', name: 'Gone'}},
            },
          ],
        },
      ],
    };
    const result = await executor.run(flow, ctx);
    assert.strictEqual(result.status, 'failed');
    assert.match(
      result.steps[0].error ?? '',
      /was not found on the current page/,
    );
    // The click never fired against a wrong element.
    assert.strictEqual(calls.length, 0);
  });
});
