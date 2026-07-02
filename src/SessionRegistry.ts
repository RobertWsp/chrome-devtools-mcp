/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {logger} from './logger.js';

/**
 * Persisted metadata for a single detached browser session. This is the single
 * source of truth that lets the server reconnect to a browser it launched in a
 * previous run (e.g. after the host terminal was closed and reopened).
 */
export interface PersistedSession {
  sessionId: string;
  wsEndpoint: string;
  userDataDir: string;
  createdAt: string;
  label?: string;
  pid?: number;
}

const DEFAULT_ROOT = path.join(
  os.homedir(),
  '.cache',
  'chrome-devtools-mcp',
  'sessions',
);

/**
 * File-backed store of {@link PersistedSession} records, one JSON file per
 * session under a root directory. Keeping one file per session avoids
 * whole-file rewrites racing across concurrent sessions.
 */
export class SessionRegistry {
  readonly #root: string;

  constructor(root: string = DEFAULT_ROOT) {
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  /** Absolute path to the persistent profile directory for a session. */
  profileDir(sessionId: string): string {
    return path.join(this.#root, sessionId, 'profile');
  }

  #metaPath(sessionId: string): string {
    return path.join(this.#root, sessionId, 'session.json');
  }

  async save(session: PersistedSession): Promise<void> {
    const dir = path.join(this.#root, session.sessionId);
    await fs.promises.mkdir(dir, {recursive: true});
    const tmp = this.#metaPath(session.sessionId) + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    // Atomic replace so a concurrent reader never sees a half-written file.
    await fs.promises.rename(tmp, this.#metaPath(session.sessionId));
  }

  /** Removes the persisted metadata and profile directory for a session. */
  async remove(sessionId: string): Promise<void> {
    const dir = path.join(this.#root, sessionId);
    await fs.promises.rm(dir, {recursive: true, force: true});
  }

  async list(): Promise<PersistedSession[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.#root, {withFileTypes: true});
    } catch {
      return [];
    }
    const sessions: PersistedSession[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const raw = await fs.promises.readFile(
          this.#metaPath(entry.name),
          'utf8',
        );
        const parsed = JSON.parse(raw) as PersistedSession;
        if (parsed.sessionId && parsed.wsEndpoint && parsed.userDataDir) {
          sessions.push(parsed);
        }
      } catch (err) {
        logger(`Ignoring invalid session registry entry ${entry.name}:`, err);
      }
    }
    return sessions;
  }
}
