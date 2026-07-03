/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Channel} from './browser.js';
import type {SessionManager} from './SessionManager.js';
import {parseViewport} from './utils/viewport.js';

/**
 * Launch defaults sourced once from the CLI, so per-session tool handlers do
 * not each reach into the global args object (single source of truth for how
 * sessions are launched).
 */
export interface SessionLaunchDefaults {
  channel?: Channel;
  executablePath?: string;
  chromeArgs: string[];
  ignoreDefaultChromeArgs: string[];
  acceptInsecureCerts?: boolean;
  devtools: boolean;
  enableExtensions?: boolean;
}

export interface CreateSessionParams {
  headless?: boolean;
  viewport?: string;
  label?: string;
  url?: string;
  /** Owner identity (isolation boundary); undefined for legacy callers. */
  ownerId?: string;
}

/**
 * Facade over {@link SessionManager} that owns the session lifecycle use cases
 * (create/list/close) plus persistence restore and host shutdown. It returns
 * plain data/markdown so the transport layer (main.ts) stays a thin adapter
 * and the business logic is testable in isolation.
 */
export class SessionService {
  readonly #manager: SessionManager;
  readonly #defaults: SessionLaunchDefaults;
  readonly #persist: boolean;

  constructor(
    manager: SessionManager,
    defaults: SessionLaunchDefaults,
    options: {persist?: boolean} = {},
  ) {
    this.#manager = manager;
    this.#defaults = defaults;
    this.#persist = options.persist ?? false;
  }

  async createSession(
    params: CreateSessionParams,
  ): Promise<{sessionId: string; body: string}> {
    const session = await this.#manager.createSession({
      headless: params.headless,
      viewport: parseViewport(params.viewport),
      label: params.label,
      ownerId: params.ownerId,
      channel: this.#defaults.channel,
      executablePath: this.#defaults.executablePath,
      chromeArgs: this.#defaults.chromeArgs,
      ignoreDefaultChromeArgs: this.#defaults.ignoreDefaultChromeArgs,
      acceptInsecureCerts: this.#defaults.acceptInsecureCerts,
      devtools: this.#defaults.devtools,
      enableExtensions: this.#defaults.enableExtensions,
    });

    if (params.url) {
      const page = session.context.getSelectedPage();
      await page.goto(params.url);
    }

    const body = [
      `Session created successfully.`,
      ``,
      `**sessionId**: \`${session.sessionId}\``,
      ``,
      `Use this sessionId in ALL subsequent tool calls.`,
      session.label ? `**label**: ${session.label}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return {sessionId: session.sessionId, body};
  }

  listSessions(ownerId?: string): string {
    const sessions = this.#manager.listSessions(ownerId);
    const lines = [`Total sessions: ${sessions.length}`, ''];
    for (const s of sessions) {
      lines.push(
        `- **${s.sessionId}**${s.label ? ` (${s.label})` : ''} — created: ${s.createdAt}, connected: ${s.connected}`,
      );
    }
    if (sessions.length === 0) {
      lines.push('No active sessions. Use create_session to create one.');
    }
    return lines.join('\n');
  }

  async closeSession(sessionId: string, ownerId?: string): Promise<string> {
    await this.#manager.closeSession(sessionId, ownerId);
    return `Session "${sessionId}" closed successfully.`;
  }

  /**
   * Reconnects persisted sessions on boot (no-op when persistence is off).
   * Returns the number of restored sessions.
   */
  async restoreSessions(): Promise<number> {
    if (!this.#persist) {
      return 0;
    }
    return this.#manager.restoreSessions();
  }

  /**
   * Host shutdown: detach (keep browsers alive) when persisting so the next
   * run can reconnect, otherwise close everything.
   */
  async shutdown(): Promise<void> {
    if (this.#persist) {
      await this.#manager.detachAllSessions();
    } else {
      await this.#manager.closeAllSessions();
    }
  }
}
