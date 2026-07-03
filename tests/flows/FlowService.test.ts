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

  it('teaches flow usage once on first interaction, then not again', async () => {
    const svc = service([tool('navigate_page', false)]);
    const first = await svc.consumeFirstInteractionNotice('s');
    assert.ok(first, 'first interaction should teach');
    assert.match(first!, /flow` op=list/);
    assert.match(first!, /flow` op=exec/);
    assert.match(first!, /No saved flows yet/);
    // Not repeated for the same session.
    assert.strictEqual(await svc.consumeFirstInteractionNotice('s'), undefined);
    // A different session is taught independently.
    assert.ok(await svc.consumeFirstInteractionNotice('other'));
  });

  it('the first-interaction teaching lists existing flows to reuse', async () => {
    const svc = service([tool('navigate_page', false)]);
    svc.observe('s', tool('navigate_page', false), {sessionId: 's', url: 'x'});
    await svc.saveRecording('s', 'login', 'logs in');
    const notice = await svc.consumeFirstInteractionNotice('s');
    assert.ok(notice);
    assert.match(notice!, /Existing flows in this project/);
    assert.match(notice!, /login \(logs in\)/);
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

  it('stores flows under each session declared project root', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-svc-b-'));
    try {
      const svc = service([tool('navigate_page', false)]);
      svc.setSessionProjectRoot('a', root);
      svc.setSessionProjectRoot('b', rootB);
      svc.observe('a', tool('navigate_page', false), {
        sessionId: 'a',
        url: 'https://a.test',
      });
      svc.observe('b', tool('navigate_page', false), {
        sessionId: 'b',
        url: 'https://b.test',
      });
      await svc.saveRecording('a', 'flow-a');
      await svc.saveRecording('b', 'flow-b');

      // Each flow lands in its own project's .cdpflows.
      assert.ok(
        await fileExists(path.join(root, '.cdpflows', 'flow-a.cdp.ts')),
      );
      assert.ok(
        await fileExists(path.join(rootB, '.cdpflows', 'flow-b.cdp.ts')),
      );
      // Cross-project lists are isolated.
      assert.deepStrictEqual(
        (await svc.list('a')).map(f => f.name),
        ['flow-a'],
      );
      assert.deepStrictEqual(
        (await svc.list('b')).map(f => f.name),
        ['flow-b'],
      );
    } finally {
      await fs.rm(rootB, {recursive: true, force: true});
    }
  });

  it('auto-saves a journey on the action cap', async () => {
    const svc = new FlowService({
      projectRoot: root,
      tools: [tool('navigate_page', false), tool('click', false)],
      getEnv: () => undefined,
      autoSave: true,
    });
    svc.setSessionProjectRoot('s', root);
    // Drive enough actions to hit the default cap (12).
    svc.observe('s', tool('navigate_page', false), {
      sessionId: 's',
      url: 'https://a.test',
    });
    for (let i = 0; i < 12; i++) {
      svc.observe('s', tool('click', false), {sessionId: 's', uid: `${i}`});
    }
    // Give the async auto-save a tick to flush.
    await new Promise(r => setTimeout(r, 50));
    const list = await svc.list('s');
    assert.ok(list.length >= 1, 'a draft journey should be auto-saved');
    assert.match(list[0].name, /^auto-/);

    // A one-shot notice is queued for the model, then cleared.
    const notices = svc.consumeAutoSaveNotices('s');
    assert.strictEqual(notices.length, 1);
    assert.match(notices[0], /reusable browser flow/);
    assert.match(notices[0], /flow op=exec/);
    // Leads with the affirmative commit action, not a negation.
    assert.match(notices[0], /ACTION: commit this file/);
    assert.match(notices[0], /git add \.cdpflows\//);
    assert.match(notices[0], /never git add -A/);
    // Consumed exactly once.
    assert.deepStrictEqual(svc.consumeAutoSaveNotices('s'), []);

    // The .env secret store is gitignored, but .cdpflows stays committable.
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.env$/m);
    assert.doesNotMatch(gitignore, /\.cdpflows/);
  });

  it('serializes concurrent auto-saves without double-saving', async () => {
    const svc = new FlowService({
      projectRoot: root,
      tools: [tool('navigate_page', false), tool('click', false)],
      getEnv: () => undefined,
      autoSave: true,
      // Small cap so a single burst triggers exactly one boundary.
      // (constructor uses defaults; drive exactly to the default cap of 12).
    });
    svc.setSessionProjectRoot('s', root);
    // Fire the whole burst synchronously so multiple auto-save evaluations
    // race on the same buffer. The per-session mutex must collapse them into
    // a single saved draft.
    svc.observe('s', tool('navigate_page', false), {
      sessionId: 's',
      url: 'https://a.test',
    });
    for (let i = 0; i < 11; i++) {
      svc.observe('s', tool('click', false), {sessionId: 's', uid: `${i}`});
    }
    await new Promise(r => setTimeout(r, 100));
    const list = await svc.list('s');
    const autos = list.filter(f => f.name.startsWith('auto-'));
    assert.strictEqual(
      autos.length,
      1,
      `expected exactly one auto-saved draft, got ${autos.length}`,
    );
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
