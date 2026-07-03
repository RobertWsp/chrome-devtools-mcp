/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it, beforeEach, afterEach} from 'node:test';

import {FlowService} from '../../src/flows/FlowService.js';
import type {Context, ToolDefinition} from '../../src/tools/ToolDefinition.js';

function tool(
  name: string,
  readOnlyHint: boolean,
  impl: (params: Record<string, unknown>) => Promise<void> = async () => {
    // no-op tool
  },
): ToolDefinition {
  return {
    name,
    description: '',
    annotations: {category: 'navigation', readOnlyHint},
    schema: {},
    handler: async (request: {params: Record<string, unknown>}) =>
      impl(request.params),
  } as unknown as ToolDefinition;
}

describe('FlowService (integration)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-service-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true});
  });

  function service(
    tools: ToolDefinition[],
    env: Record<string, string> = {},
  ): FlowService {
    return new FlowService({
      projectRoot: root,
      tools,
      getEnv: name => env[name],
    });
  }

  it('records, saves with secret extraction, and lists', async () => {
    const svc = service([tool('navigate_page', false), tool('fill', false)]);

    svc.observe('sess1', tool('navigate_page', false), {
      sessionId: 'sess1',
      url: 'https://app.test',
    });
    svc.observe('sess1', tool('fill', false), {
      sessionId: 'sess1',
      uid: '1_2',
      password: 'hunter2',
    });
    // Read-only tool must not be recorded.
    svc.observe('sess1', tool('list_pages', true), {sessionId: 'sess1'});

    const {file, flow} = await svc.saveRecording('sess1', 'login', 'demo');
    assert.ok(file.endsWith('login.cdp.ts'));
    assert.ok(flow.env.length === 1, 'password extracted to env');

    // Secret persisted to .env, not embedded in the flow file.
    const source = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(source, /hunter2/);
    const envFile = await fs.readFile(path.join(root, '.env'), 'utf8');
    assert.match(envFile, /hunter2/);

    const list = await svc.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'login');
    assert.strictEqual(list[0].actions, 2);
  });

  it('validates a stored flow', async () => {
    const svc = service([tool('navigate_page', false)]);
    svc.observe('s', tool('navigate_page', false), {
      sessionId: 's',
      url: 'x',
    });
    await svc.saveRecording('s', 'nav');
    const result = await svc.validateStored('nav');
    assert.strictEqual(result.valid, true);
  });

  it('replays a saved flow resolving secrets from env', async () => {
    const filled: unknown[] = [];
    const tools = [
      tool('navigate_page', false),
      tool('fill', false, async params => {
        filled.push(params.password ?? params.value);
      }),
    ];
    // The service used to record does not need env; the replay one does.
    const recorder = service(tools);
    recorder.observe('s', tools[0], {sessionId: 's', url: 'x'});
    recorder.observe('s', tools[1], {
      sessionId: 's',
      uid: '1',
      password: 'topsecret',
    });
    const {flow} = await recorder.saveRecording('s', 'login');
    const envVar = flow.env[0];

    const replayer = service(tools, {[envVar]: 'topsecret'});
    const result = await replayer.exec('login', {} as Context);
    assert.strictEqual(result.status, 'passed');
    assert.deepStrictEqual(filled, ['topsecret']);
  });

  it('rejects saving a flow that fails validation', async () => {
    // A tool that is not registered -> unknown tool error on save.
    const svc = service([tool('navigate_page', false)]);
    svc.observe('s', tool('ghost_tool', false), {sessionId: 's', x: 1});
    await assert.rejects(
      () => svc.saveRecording('s', 'broken'),
      /validation failed/i,
    );
  });

  it('isolates recordings per session', async () => {
    const svc = service([tool('navigate_page', false)]);
    svc.observe('a', tool('navigate_page', false), {sessionId: 'a', url: '1'});
    svc.observe('b', tool('navigate_page', false), {sessionId: 'b', url: '2'});
    assert.strictEqual(svc.recorderFor('a').size, 1);
    assert.strictEqual(svc.recorderFor('b').size, 1);
    svc.disposeRecorder('a');
    assert.strictEqual(svc.recorderFor('a').size, 0);
    assert.strictEqual(svc.recorderFor('b').size, 1);
  });
});
