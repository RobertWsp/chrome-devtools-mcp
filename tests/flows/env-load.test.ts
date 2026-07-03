/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {describe, it, beforeEach, afterEach} from 'node:test';

import {readEnvFile} from '../../src/flows/env-file.js';

describe('readEnvFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-env-load-'));
  });

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true});
  });

  it('returns an empty map when .env is absent', () => {
    assert.strictEqual(readEnvFile(root).size, 0);
  });

  it('parses key=value pairs from .env', async () => {
    await fs.writeFile(
      path.join(root, '.env'),
      'FOO=bar\n# comment\nBAZ=qux\n\n',
      'utf8',
    );
    const env = readEnvFile(root);
    assert.strictEqual(env.get('FOO'), 'bar');
    assert.strictEqual(env.get('BAZ'), 'qux');
    assert.strictEqual(env.size, 2);
  });

  it('does not mutate process.env', async () => {
    const key = `FLOW_TEST_NOMUTATE_${process.pid}`;
    await fs.writeFile(path.join(root, '.env'), `${key}=x\n`, 'utf8');
    readEnvFile(root);
    assert.strictEqual(process.env[key], undefined);
  });

  it('isolates two project roots', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-env-b-'));
    try {
      await fs.writeFile(path.join(root, '.env'), 'K=a\n', 'utf8');
      await fs.writeFile(path.join(rootB, '.env'), 'K=b\n', 'utf8');
      assert.strictEqual(readEnvFile(root).get('K'), 'a');
      assert.strictEqual(readEnvFile(rootB).get('K'), 'b');
    } finally {
      await fs.rm(rootB, {recursive: true, force: true});
    }
  });
});
