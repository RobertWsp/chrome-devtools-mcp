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

import {persistSecrets, ensureGitignored} from '../../src/flows/env-file.js';
import type {Flow} from '../../src/flows/flow-model.js';
import {FlowStore} from '../../src/flows/flow-store.js';

describe('flow-store and env-file', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-store-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true});
  });

  const flow: Flow = {
    name: 'login',
    description: 'demo',
    env: ['LOGIN_PASSWORD'],
    steps: [
      {name: 'open', actions: [{tool: 'navigate_page', params: {url: 'x'}}]},
    ],
  };

  it('saves, loads and lists a flow round-trip', async () => {
    const store = new FlowStore(root);
    const file = await store.save(flow);
    assert.ok(file.endsWith('login.cdp.ts'));

    const loaded = await store.load('login');
    assert.strictEqual(loaded.name, 'login');
    assert.deepStrictEqual(loaded.steps, flow.steps);
    assert.ok(loaded.createdAt, 'save stamps createdAt');

    const summaries = await store.list();
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].name, 'login');
    assert.strictEqual(summaries[0].steps, 1);
    assert.strictEqual(summaries[0].actions, 1);
  });

  it('writes the runtime shim alongside flows', async () => {
    const store = new FlowStore(root);
    await store.save(flow);
    const runtime = await fs.readFile(
      path.join(store.dir, 'runtime.ts'),
      'utf8',
    );
    assert.match(runtime, /export function defineFlow/);
    assert.match(runtime, /export function env/);
  });

  it('gitignores .env on save (secrets never committable) but not .cdpflows', async () => {
    const store = new FlowStore(root);
    await store.save(flow);
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    // The secret store is ignored...
    assert.match(gitignore, /^\.env$/m);
    // ...but the flows dir is intentionally committable (not ignored).
    assert.doesNotMatch(gitignore, /\.cdpflows/);
  });

  it('list returns empty when dir is missing', async () => {
    const store = new FlowStore(path.join(root, 'nope'));
    assert.deepStrictEqual(await store.list(), []);
  });

  it('persistSecrets writes .env, .env.example and gitignores .env', async () => {
    await persistSecrets(root, [{envVar: 'LOGIN_PASSWORD', value: 'hunter2'}]);
    const env = await fs.readFile(path.join(root, '.env'), 'utf8');
    const example = await fs.readFile(path.join(root, '.env.example'), 'utf8');
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');

    assert.match(env, /LOGIN_PASSWORD=hunter2/);
    assert.match(example, /LOGIN_PASSWORD=/);
    assert.doesNotMatch(example, /hunter2/);
    assert.match(gitignore, /^\.env$/m);
  });

  it('persistSecrets never overwrites an existing value', async () => {
    await fs.writeFile(path.join(root, '.env'), 'LOGIN_PASSWORD=original\n');
    await persistSecrets(root, [
      {envVar: 'LOGIN_PASSWORD', value: 'different'},
    ]);
    const env = await fs.readFile(path.join(root, '.env'), 'utf8');
    assert.match(env, /LOGIN_PASSWORD=original/);
    assert.doesNotMatch(env, /different/);
  });

  it('ensureGitignored is idempotent', async () => {
    await ensureGitignored(root, '.env');
    await ensureGitignored(root, '.env');
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    const count = gitignore.split('\n').filter(l => l.trim() === '.env').length;
    assert.strictEqual(count, 1);
  });
});
