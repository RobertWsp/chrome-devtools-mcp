/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import type {ExtractedSecret} from './secret-scanner.js';

const ENV_FILE = '.env';
const ENV_EXAMPLE_FILE = '.env.example';
const GITIGNORE_FILE = '.gitignore';

/**
 * Loads `<projectRoot>/.env` into `process.env` if present, WITHOUT overriding
 * variables already set in the real environment (an explicit env var always
 * wins over the persisted file). This is what makes secret placeholders in a
 * flow resolvable at replay time -- the same file `persistSecrets` writes is
 * the single source of truth for values, and this is the only place it is
 * read back into the process. Missing file is a no-op.
 */
export function loadEnvFile(projectRoot: string): void {
  const envPath = path.join(projectRoot, ENV_FILE);
  if (!existsSync(envPath)) {
    return;
  }
  // Snapshot keys that are already set so a real env var wins over the file.
  const preset = new Set(Object.keys(process.env));
  const before: Record<string, string | undefined> = {};
  for (const key of preset) {
    before[key] = process.env[key];
  }
  process.loadEnvFile(envPath);
  // Restore any preset key the file may have overwritten.
  for (const key of preset) {
    process.env[key] = before[key];
  }
}

function parseEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return map;
}

function serializeEnv(map: Map<string, string>): string {
  return [...map].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

async function readFileOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Persists extracted secrets outside version control. New keys are appended to
 * `.env` (never overwriting an existing value), every key is mirrored to
 * `.env.example` with an empty placeholder, and `.env` is guaranteed to be
 * gitignored so secrets are never committed.
 *
 * This is the single source of truth for where secret values live.
 */
export async function persistSecrets(
  projectRoot: string,
  secrets: ExtractedSecret[],
): Promise<void> {
  if (secrets.length === 0) {
    return;
  }

  const envPath = path.join(projectRoot, ENV_FILE);
  const examplePath = path.join(projectRoot, ENV_EXAMPLE_FILE);

  const env = parseEnv(await readFileOrEmpty(envPath));
  const example = parseEnv(await readFileOrEmpty(examplePath));

  for (const {envVar, value} of secrets) {
    if (!env.has(envVar)) {
      env.set(envVar, value);
    }
    example.set(envVar, '');
  }

  await fs.writeFile(envPath, serializeEnv(env), 'utf8');
  await fs.writeFile(examplePath, serializeEnv(example), 'utf8');
  await ensureGitignored(projectRoot, ENV_FILE);
}

/**
 * Ensures `entry` is present in the project's `.gitignore`, creating the file
 * if needed. Idempotent.
 */
export async function ensureGitignored(
  projectRoot: string,
  entry: string,
): Promise<void> {
  const gitignorePath = path.join(projectRoot, GITIGNORE_FILE);
  const content = await readFileOrEmpty(gitignorePath);
  const lines = content.split('\n').map(l => l.trim());
  if (lines.includes(entry)) {
    return;
  }
  const prefix = content.length && !content.endsWith('\n') ? '\n' : '';
  await fs.appendFile(gitignorePath, `${prefix}${entry}\n`, 'utf8');
}
