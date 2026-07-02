/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import type {Channel} from './browser.js';
import {launch, reconnectBrowser} from './browser.js';
import {logger} from './logger.js';
import {McpContext} from './McpContext.js';
import {Mutex} from './Mutex.js';
import type {SessionRegistry} from './SessionRegistry.js';
import type {Browser} from './third_party/index.js';

export interface SessionInfo {
  sessionId: string;
  browser: Browser;
  context: McpContext;
  mutex: Mutex;
  createdAt: Date;
  label?: string;
  /** Persisted reconnect endpoint, present for detached sessions. */
  wsEndpoint?: string;
  userDataDir?: string;
}

export interface CreateSessionOptions {
  headless?: boolean;
  executablePath?: string;
  channel?: Channel;
  userDataDir?: string;
  viewport?: {width: number; height: number};
  chromeArgs?: string[];
  ignoreDefaultChromeArgs?: string[];
  acceptInsecureCerts?: boolean;
  devtools?: boolean;
  enableExtensions?: boolean;
  label?: string;
}

export interface McpContextOptions {
  experimentalDevToolsDebugging: boolean;
  experimentalIncludeAllPages?: boolean;
  performanceCrux: boolean;
}

export class SessionManager {
  readonly #sessions = new Map<string, SessionInfo>();
  readonly #contextOptions: McpContextOptions;
  readonly #registry?: SessionRegistry;
  readonly #detached: boolean;
  #shuttingDown = false;

  constructor(
    contextOptions: McpContextOptions,
    options: {registry?: SessionRegistry; detached?: boolean} = {},
  ) {
    this.#contextOptions = contextOptions;
    this.#registry = options.registry;
    this.#detached = options.detached ?? false;
  }

  #newSessionId(): string {
    let id = crypto.randomUUID().slice(0, 8);
    // Guarantee uniqueness even against persisted/restored sessions.
    while (this.#sessions.has(id)) {
      id = crypto.randomUUID().slice(0, 8);
    }
    return id;
  }

  async createSession(options: CreateSessionOptions): Promise<SessionInfo> {
    if (this.#shuttingDown) {
      throw new Error('Server is shutting down. Cannot create new sessions.');
    }

    const sessionId = this.#newSessionId();
    logger(`Creating session ${sessionId}`);

    // Detached sessions need a stable per-session profile on disk so they can
    // be reconnected after the host restarts. Non-detached sessions stay fully
    // isolated in a temp dir cleaned up on close.
    const detached = this.#detached && !!this.#registry;
    const userDataDir =
      options.userDataDir ??
      (detached ? this.#registry!.profileDir(sessionId) : undefined);

    let browser: Browser | undefined;
    try {
      browser = await launch({
        headless: options.headless ?? false,
        executablePath: options.executablePath,
        channel: options.channel,
        userDataDir,
        // Isolated (temp dir) unless we persist a dedicated profile per session.
        isolated: !userDataDir,
        detached,
        viewport: options.viewport,
        chromeArgs: options.chromeArgs ?? [],
        ignoreDefaultChromeArgs: options.ignoreDefaultChromeArgs ?? [],
        acceptInsecureCerts: options.acceptInsecureCerts,
        devtools: options.devtools ?? false,
        enableExtensions: options.enableExtensions,
      });

      const context = await McpContext.from(
        browser,
        logger,
        this.#contextOptions,
      );
      const mutex = new Mutex();
      const createdAt = new Date();
      const wsEndpoint = detached ? browser.wsEndpoint() : undefined;

      const session: SessionInfo = {
        sessionId,
        browser,
        context,
        mutex,
        createdAt,
        label: options.label,
        wsEndpoint,
        userDataDir,
      };

      browser.on('disconnected', () => {
        logger(`Session ${sessionId} browser disconnected unexpectedly`);
        // A host-initiated disconnect during shutdown keeps the detached
        // browser alive and its registry entry intact for later reconnect.
        this.#purgeDisconnectedSession(sessionId);
      });

      this.#sessions.set(sessionId, session);

      if (detached && wsEndpoint) {
        await this.#registry!.save({
          sessionId,
          wsEndpoint,
          userDataDir: userDataDir!,
          createdAt: createdAt.toISOString(),
          label: options.label,
          pid: browser.process()?.pid,
        });
      }

      logger(`Session ${sessionId} created`);
      return session;
    } catch (err) {
      if (browser?.connected) {
        try {
          await browser.close();
        } catch (closeErr) {
          logger(`Failed to close browser after creation failure:`, closeErr);
        }
      }
      throw err;
    }
  }

  getSession(sessionId: string): SessionInfo {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      const available = [...this.#sessions.keys()].join(', ');
      throw new Error(
        `Session "${sessionId}" not found. Available sessions: ${available || 'none. Create one with create_session.'}`,
      );
    }
    if (!session.browser.connected) {
      this.#purgeDisconnectedSession(sessionId);
      throw new Error(
        `Session "${sessionId}" browser is disconnected. Create a new session.`,
      );
    }
    return session;
  }

  listSessions(): Array<{
    sessionId: string;
    createdAt: string;
    label?: string;
    connected: boolean;
  }> {
    const result: Array<{
      sessionId: string;
      createdAt: string;
      label?: string;
      connected: boolean;
    }> = [];

    for (const [, session] of this.#sessions) {
      result.push({
        sessionId: session.sessionId,
        createdAt: session.createdAt.toISOString(),
        label: session.label,
        connected: session.browser.connected,
      });
    }
    return result;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    logger(`Closing session ${sessionId} (acquiring mutex)`);
    const guard = await session.mutex.acquire();
    try {
      session.context.dispose();
      if (session.browser.connected) {
        await session.browser.close();
      }
    } catch (err) {
      logger(`Error closing session ${sessionId}:`, err);
    } finally {
      guard.dispose();
      this.#sessions.delete(sessionId);
      // Permanent close: drop the persisted profile + metadata.
      if (this.#registry) {
        await this.#registry.remove(sessionId).catch(err => {
          logger(`Error removing registry for ${sessionId}:`, err);
        });
      }
      logger(`Session ${sessionId} closed`);
    }
  }

  async closeAllSessions(): Promise<void> {
    this.#shuttingDown = true;
    const ids = [...this.#sessions.keys()];
    await Promise.allSettled(ids.map(id => this.closeSession(id)));
  }

  /**
   * Host is shutting down but we want detached browsers to survive. Disconnects
   * from each browser without closing it and leaves the registry intact so the
   * next run can reconnect. For non-detached sessions this closes the browser.
   */
  async detachAllSessions(): Promise<void> {
    this.#shuttingDown = true;
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(
      sessions.map(async session => {
        try {
          session.context.dispose();
          if (session.wsEndpoint && session.browser.connected) {
            // Keep the browser process alive; only drop our connection.
            await session.browser.disconnect();
          } else if (session.browser.connected) {
            await session.browser.close();
          }
        } catch (err) {
          logger(`Error detaching session ${session.sessionId}:`, err);
        }
      }),
    );
    this.#sessions.clear();
  }

  /**
   * Reconnects to detached browsers persisted in the registry. Dead endpoints
   * (browser gone) are garbage-collected. Returns the number of restored
   * sessions.
   */
  async restoreSessions(): Promise<number> {
    if (!this.#registry) {
      return 0;
    }
    const persisted = await this.#registry.list();
    let restored = 0;
    for (const entry of persisted) {
      if (this.#sessions.has(entry.sessionId)) {
        continue;
      }
      try {
        const browser = await reconnectBrowser(entry.wsEndpoint);
        const context = await McpContext.from(
          browser,
          logger,
          this.#contextOptions,
        );
        const session: SessionInfo = {
          sessionId: entry.sessionId,
          browser,
          context,
          mutex: new Mutex(),
          createdAt: new Date(entry.createdAt),
          label: entry.label,
          wsEndpoint: entry.wsEndpoint,
          userDataDir: entry.userDataDir,
        };
        browser.on('disconnected', () => {
          logger(`Session ${entry.sessionId} browser disconnected`);
          this.#purgeDisconnectedSession(entry.sessionId);
        });
        this.#sessions.set(entry.sessionId, session);
        restored++;
        logger(`Restored session ${entry.sessionId}`);
      } catch (err) {
        // Browser is gone: this session is irrecoverable, GC its registry entry.
        logger(`Could not restore session ${entry.sessionId}, purging:`, err);
        await this.#registry.remove(entry.sessionId).catch(() => {
          // best-effort GC
        });
      }
    }
    return restored;
  }

  /** Live session objects, for in-process inspection (not serialized). */
  listSessionInfos(): SessionInfo[] {
    return [...this.#sessions.values()];
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  #purgeDisconnectedSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return;
    }
    try {
      session.context.dispose();
    } catch (err) {
      logger(
        `Error disposing context for disconnected session ${sessionId}:`,
        err,
      );
    }
    this.#sessions.delete(sessionId);
    // A browser that died while the host is running is irrecoverable: drop its
    // registry entry. During a graceful host shutdown (detachAllSessions) we
    // keep it so the browser can be reconnected next run.
    if (this.#registry && !this.#shuttingDown) {
      void this.#registry.remove(sessionId).catch(err => {
        logger(`Error removing registry for dead session ${sessionId}:`, err);
      });
    }
    logger(`Purged disconnected session ${sessionId}`);
  }
}
