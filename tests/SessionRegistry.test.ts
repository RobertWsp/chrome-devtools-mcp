/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, it, beforeEach, afterEach} from 'node:test';

import {SessionRegistry} from '../src/SessionRegistry.js';
import type {PersistedSession} from '../src/SessionRegistry.js';

describe('SessionRegistry', () => {
  let root: string;
  let registry: SessionRegistry;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'session-registry-test-'),
    );
    registry = new SessionRegistry(root);
  });

  afterEach(async () => {
    await fs.promises.rm(root, {recursive: true, force: true});
  });

  function makeSession(id: string): PersistedSession {
    return {
      sessionId: id,
      wsEndpoint: `ws://127.0.0.1:9222/devtools/browser/${id}`,
      userDataDir: registry.profileDir(id),
      createdAt: new Date().toISOString(),
      label: `label-${id}`,
      // Owner must round-trip so a restored session keeps its isolation.
      ownerId: `owner-${id}`,
    };
  }

  it('saves and lists a session', async () => {
    const session = makeSession('aaa11111');
    await registry.save(session);

    const list = await registry.list();
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(list[0], session);
  });

  it('returns empty list when root does not exist', async () => {
    const missing = new SessionRegistry(path.join(root, 'nope'));
    assert.deepStrictEqual(await missing.list(), []);
  });

  it('overwrites an existing session atomically', async () => {
    const session = makeSession('bbb22222');
    await registry.save(session);
    const updated = {...session, label: 'renamed'};
    await registry.save(updated);

    const list = await registry.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].label, 'renamed');
  });

  it('removes a session and its profile dir', async () => {
    const session = makeSession('ccc33333');
    await registry.save(session);
    // Simulate a profile directory on disk.
    await fs.promises.mkdir(registry.profileDir(session.sessionId), {
      recursive: true,
    });

    await registry.remove(session.sessionId);

    assert.deepStrictEqual(await registry.list(), []);
    assert.strictEqual(
      fs.existsSync(path.join(root, session.sessionId)),
      false,
    );
  });

  it('ignores invalid registry entries', async () => {
    const good = makeSession('ddd44444');
    await registry.save(good);
    // A directory without a valid session.json.
    const badDir = path.join(root, 'garbage');
    await fs.promises.mkdir(badDir, {recursive: true});
    await fs.promises.writeFile(
      path.join(badDir, 'session.json'),
      '{ not valid json',
      'utf8',
    );

    const list = await registry.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].sessionId, 'ddd44444');
  });

  it('drops entries missing required fields', async () => {
    const dir = path.join(root, 'eee55555');
    await fs.promises.mkdir(dir, {recursive: true});
    await fs.promises.writeFile(
      path.join(dir, 'session.json'),
      JSON.stringify({sessionId: 'eee55555'}),
      'utf8',
    );
    assert.deepStrictEqual(await registry.list(), []);
  });
});
