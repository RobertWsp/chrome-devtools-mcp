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

import {loadEnvFile} from '../../src/flows/env-file.js';

describe('loadEnvFile', () => {
  let root: string;
  const touched: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-env-load-'));
  });

  afterEach(async () => {
    for (const key of touched) {
      delete process.env[key];
    }
    touched.length = 0;
    await fs.rm(root, {recursive: true, force: true});
  });

  it('is a no-op when .env is absent', () => {
    assert.doesNotThrow(() => loadEnvFile(root));
  });

  it('loads values from .env into process.env', async () => {
    const key = `FLOW_TEST_LOADED_${process.pid}`;
    touched.push(key);
    await fs.writeFile(path.join(root, '.env'), `${key}=from_file\n`, 'utf8');
    loadEnvFile(root);
    assert.strictEqual(process.env[key], 'from_file');
  });

  it('does not override a variable already set in the real environment', async () => {
    const key = `FLOW_TEST_PRESET_${process.pid}`;
    touched.push(key);
    process.env[key] = 'from_env';
    await fs.writeFile(path.join(root, '.env'), `${key}=from_file\n`, 'utf8');
    loadEnvFile(root);
    assert.strictEqual(
      process.env[key],
      'from_env',
      'explicit env var must win over the persisted file',
    );
  });
});
