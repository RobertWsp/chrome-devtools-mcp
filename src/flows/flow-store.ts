/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {generateFlowSource} from './codegen.js';
import {ensureGitignored} from './env-file.js';
import type {Flow} from './flow-model.js';
import {FLOW_FILE_EXTENSION, FLOWS_DIR} from './flow-model.js';
import {parseFlowSource} from './flow-parser.js';

export interface FlowSummary {
  name: string;
  description: string;
  steps: number;
  actions: number;
  env: string[];
  file: string;
}

/** Minimal runtime shim imported by generated `.cdp.ts` files. */
const RUNTIME_SOURCE = `/**
 * Runtime helpers for generated CDP flows. These give the .cdp.ts files valid
 * types and an \`env()\` marker; execution is performed by the MCP server's
 * flow executor, which reads the flow structurally rather than importing it.
 */
export interface FlowContext {
  step(name: string, run: () => Promise<void>): Promise<void>;
  step(name: string, description: string, run: () => Promise<void>): Promise<void>;
  run(tool: string, params: Record<string, unknown>): Promise<void>;
}

export interface FlowDefinition {
  name: string;
  description: string;
  env: string[];
  createdAt?: string;
  updatedAt?: string;
  steps: (ctx: FlowContext) => Promise<void>;
}

export function defineFlow(def: FlowDefinition): FlowDefinition {
  return def;
}

/** Marks a value as sourced from an environment variable. */
export function env(name: string): {__env: string} {
  return {__env: name};
}
`;

/**
 * File-backed CRUD for flows under `<projectRoot>/.cdpflows`. Each flow is one
 * reviewable `.cdp.ts` file; codegen/parse keep the on-disk form and the AST in
 * sync (single source of truth is the {@link Flow} model).
 */
export class FlowStore {
  readonly #dir: string;
  readonly #projectRoot: string;

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.#dir = path.join(projectRoot, FLOWS_DIR);
  }

  get dir(): string {
    return this.#dir;
  }

  get projectRoot(): string {
    return this.#projectRoot;
  }

  filePath(name: string): string {
    return path.join(this.#dir, `${name}${FLOW_FILE_EXTENSION}`);
  }

  async #ensureDir(): Promise<void> {
    await fs.mkdir(this.#dir, {recursive: true});
    // Keep the runtime shim next to the flows so imports resolve and the
    // folder is self-contained when committed.
    const runtimePath = path.join(this.#dir, 'runtime.ts');
    try {
      const existing = await fs.readFile(runtimePath, 'utf8');
      if (existing === RUNTIME_SOURCE) {
        return;
      }
    } catch {
      // missing -> write it
    }
    await fs.writeFile(runtimePath, RUNTIME_SOURCE, 'utf8');
  }

  async save(flow: Flow): Promise<string> {
    await this.#ensureDir();
    // A flow's `.env` (created lazily when a secret is extracted) must never be
    // committable. Guarantee the ignore up-front, on every save, so it holds
    // even for flows that don't yet carry a secret. The `.cdpflows/` dir itself
    // is INTENTIONALLY committable — sharing flows with the project is the
    // whole point; only the secret store is ignored.
    await ensureGitignored(this.#projectRoot, '.env');
    const now = new Date().toISOString();
    const toWrite: Flow = {
      ...flow,
      createdAt: flow.createdAt ?? now,
      updatedAt: now,
    };
    const file = this.filePath(flow.name);
    await fs.writeFile(file, generateFlowSource(toWrite), 'utf8');
    return file;
  }

  async load(name: string): Promise<Flow> {
    const source = await fs.readFile(this.filePath(name), 'utf8');
    return parseFlowSource(source);
  }

  async readSource(name: string): Promise<string> {
    return fs.readFile(this.filePath(name), 'utf8');
  }

  async exists(name: string): Promise<boolean> {
    try {
      await fs.access(this.filePath(name));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<FlowSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.#dir);
    } catch {
      return [];
    }
    const summaries: FlowSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(FLOW_FILE_EXTENSION)) {
        continue;
      }
      const name = entry.slice(0, -FLOW_FILE_EXTENSION.length);
      try {
        const flow = await this.load(name);
        summaries.push({
          name: flow.name,
          description: flow.description,
          steps: flow.steps.length,
          actions: flow.steps.reduce((n, s) => n + s.actions.length, 0),
          env: flow.env,
          file: this.filePath(name),
        });
      } catch {
        // Skip unparseable files in listings; validate surfaces the error.
      }
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }
}
