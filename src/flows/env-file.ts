/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {existsSync, readFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {ExtractedSecret} from './secret-scanner.js';

/**
 * Single source of truth for the secret-store filename. Exported so messaging
 * and the flow store reference the same name instead of hardcoding `.env`.
 */
export const SECRET_STORE_FILE = '.env';
const ENV_FILE = SECRET_STORE_FILE;
const ENV_EXAMPLE_FILE = '.env.example';
const GITIGNORE_FILE = '.gitignore';

/**
 * Reads `<projectRoot>/.env` into a Map without touching `process.env`. This
 * is how flow env references resolve per-project at replay time: each project
 * root has its own `.env` (the same file `persistSecrets` writes), and callers
 * layer a real-env fallback on top so an explicit env var still wins. Returns
 * an empty map when the file is absent. No global mutation keeps concurrent
 * sessions in different projects isolated.
 */
export function readEnvFile(projectRoot: string): Map<string, string> {
  const envPath = path.join(projectRoot, ENV_FILE);
  if (!existsSync(envPath)) {
    return new Map();
  }
  try {
    return parseEnv(readFileSync(envPath, 'utf8'));
  } catch {
    return new Map();
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
