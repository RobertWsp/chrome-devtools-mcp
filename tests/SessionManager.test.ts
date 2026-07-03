/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';

import {SessionManager} from '../src/SessionManager.js';
import {SessionRegistry} from '../src/SessionRegistry.js';

const contextOptions = {
  experimentalDevToolsDebugging: false,
  performanceCrux: false,
};

/**
 * Removes a directory, retrying briefly on ENOTEMPTY. Detached Chrome can keep
 * flushing its profile for a moment after the browser is asked to close, which
 * otherwise makes teardown flaky.
 */
async function rmWithRetry(dir: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.promises.rm(dir, {recursive: true, force: true});
      return;
    } catch (err) {
      if (i === attempts - 1) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

describe('SessionManager', () => {
  const managers: SessionManager[] = [];

  function createManager(): SessionManager {
    const m = new SessionManager(contextOptions);
    managers.push(m);
    return m;
  }

  afterEach(async () => {
    for (const m of managers) {
      try {
        await m.closeAllSessions();
      } catch {
        // ignore
      }
    }
    managers.length = 0;
  });

  describe('createSession', () => {
    it('creates a session and returns session info', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});

      assert.ok(session.sessionId, 'sessionId should exist');
      assert.strictEqual(
        session.sessionId.length,
        8,
        'sessionId should be 8 chars',
      );
      assert.ok(session.browser, 'browser should exist');
      assert.ok(session.browser.connected, 'browser should be connected');
      assert.ok(session.context, 'context should exist');
      assert.ok(session.mutex, 'mutex should exist');
      assert.ok(session.createdAt instanceof Date, 'createdAt should be Date');
      assert.strictEqual(manager.sessionCount, 1);
    });

    it('assigns label when provided', async () => {
      const manager = createManager();
      const session = await manager.createSession({
        headless: true,
        label: 'test-label',
      });

      assert.strictEqual(session.label, 'test-label');
    });

    it('generates unique session IDs', async () => {
      const manager = createManager();
      const session1 = await manager.createSession({headless: true});
      const session2 = await manager.createSession({headless: true});

      assert.notStrictEqual(
        session1.sessionId,
        session2.sessionId,
        'session IDs must be unique',
      );
      assert.strictEqual(manager.sessionCount, 2);
    });

    it('rejects creation when shutting down', async () => {
      const manager = createManager();
      await manager.closeAllSessions();

      await assert.rejects(() => manager.createSession({headless: true}), {
        message: /shutting down/i,
      });
    });
  });

  describe('getSession', () => {
    it('returns session by ID', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});
      const retrieved = manager.getSession(session.sessionId);

      assert.strictEqual(retrieved.sessionId, session.sessionId);
      assert.strictEqual(retrieved.browser, session.browser);
      assert.strictEqual(retrieved.context, session.context);
    });

    it('throws for unknown session ID', () => {
      const manager = createManager();

      assert.throws(() => manager.getSession('deadbeef'), {
        message: /not found/i,
      });
    });

    it('throws and purges for disconnected browser', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});

      await session.browser.close();
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.throws(() => manager.getSession(session.sessionId), {
        message: /not found|disconnected/i,
      });
      assert.strictEqual(manager.sessionCount, 0);
    });
  });

  describe('listSessions', () => {
    it('returns empty list when no sessions', () => {
      const manager = createManager();
      const list = manager.listSessions();
      assert.deepStrictEqual(list, []);
    });

    it('returns all active sessions', async () => {
      const manager = createManager();
      await manager.createSession({headless: true, label: 'one'});
      await manager.createSession({headless: true, label: 'two'});

      const list = manager.listSessions();
      assert.strictEqual(list.length, 2);

      const labels = list.map(s => s.label).sort();
      assert.deepStrictEqual(labels, ['one', 'two']);
      for (const s of list) {
        assert.ok(s.sessionId);
        assert.ok(s.createdAt);
        assert.strictEqual(s.connected, true);
      }
    });
  });

  describe('closeSession', () => {
    it('closes and removes session', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});

      assert.strictEqual(manager.sessionCount, 1);
      await manager.closeSession(session.sessionId);
      assert.strictEqual(manager.sessionCount, 0);
    });

    it('throws for unknown session ID', async () => {
      const manager = createManager();

      await assert.rejects(() => manager.closeSession('deadbeef'), {
        message: /not found/i,
      });
    });

    it('handles already-disconnected browser gracefully', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});
      const id = session.sessionId;

      await session.browser.close();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        await manager.closeSession(id);
      } catch {
        // auto-purge may have already removed it — that's the expected behavior
      }
      assert.strictEqual(manager.sessionCount, 0);
    });
  });

  describe('closeAllSessions', () => {
    it('closes all sessions', async () => {
      const manager = createManager();
      await manager.createSession({headless: true});
      await manager.createSession({headless: true});
      await manager.createSession({headless: true});

      assert.strictEqual(manager.sessionCount, 3);
      await manager.closeAllSessions();
      assert.strictEqual(manager.sessionCount, 0);
    });
  });

  describe('parallel sessions', () => {
    it('two sessions can navigate to different URLs independently', async () => {
      const manager = createManager();
      const session1 = await manager.createSession({headless: true});
      const session2 = await manager.createSession({headless: true});

      const page1 = session1.context.getSelectedPage();
      const page2 = session2.context.getSelectedPage();

      await Promise.all([
        page1.goto('data:text/html,<h1>Session One</h1>'),
        page2.goto('data:text/html,<h1>Session Two</h1>'),
      ]);

      const title1 = await page1.evaluate(
        () => document.querySelector('h1')?.textContent,
      );
      const title2 = await page2.evaluate(
        () => document.querySelector('h1')?.textContent,
      );

      assert.strictEqual(title1, 'Session One');
      assert.strictEqual(title2, 'Session Two');
    });

    it('closing one session does not affect another', async () => {
      const manager = createManager();
      const session1 = await manager.createSession({headless: true});
      const session2 = await manager.createSession({headless: true});

      await manager.closeSession(session1.sessionId);

      assert.strictEqual(manager.sessionCount, 1);
      assert.ok(
        session2.browser.connected,
        'session2 browser should still be connected',
      );

      const page2 = session2.context.getSelectedPage();
      await page2.goto('data:text/html,<p>Still alive</p>');
      const text = await page2.evaluate(
        () => document.querySelector('p')?.textContent,
      );
      assert.strictEqual(text, 'Still alive');
    });

    it('per-session mutex serializes within session but allows cross-session parallelism', async () => {
      const manager = createManager();
      const session1 = await manager.createSession({headless: true});
      const session2 = await manager.createSession({headless: true});

      const order: string[] = [];

      const guard1 = await session1.mutex.acquire();

      const session1SecondAcquire = session1.mutex.acquire().then(g => {
        order.push('s1-second');
        g.dispose();
      });

      const guard2 = await session2.mutex.acquire();
      order.push('s2-first');
      guard2.dispose();

      guard1.dispose();
      await session1SecondAcquire;

      assert.strictEqual(
        order[0],
        's2-first',
        'session2 should acquire before session1 second acquire',
      );
      assert.strictEqual(order[1], 's1-second');
    });
  });

  describe('auto-purge on disconnect', () => {
    it('removes session when browser disconnects unexpectedly', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});

      assert.strictEqual(manager.sessionCount, 1);

      const browserProcess = session.browser.process();
      if (browserProcess) {
        browserProcess.kill('SIGKILL');
        await new Promise<void>(resolve => {
          session.browser.on('disconnected', () => resolve());
        });
      } else {
        await session.browser.close();
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(
        manager.sessionCount,
        0,
        'session should be auto-purged after disconnect',
      );
    });
  });

  describe('idle reaping', () => {
    it('touchSession updates lastActivityAt', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});
      const before = session.lastActivityAt;
      await new Promise(r => setTimeout(r, 5));
      manager.touchSession(session.sessionId);
      assert.ok(session.lastActivityAt >= before);
    });

    it('reapIdleSessions closes fully-idle sessions and keeps active ones', async () => {
      const manager = createManager();
      const idle = await manager.createSession({headless: true});
      const active = await manager.createSession({headless: true});

      // A tiny window: after a short sleep both look "idle" by the window, so
      // touch `active` right before reaping to keep it alive. `idle` is left
      // untouched (its only activity is creation).
      await new Promise(r => setTimeout(r, 30));
      manager.touchSession(active.sessionId);
      active.context.touchSelectedPage();

      const reaped = await manager.reapIdleSessions(20);
      assert.strictEqual(reaped, 1);
      assert.strictEqual(manager.sessionCount, 1);
      // The active session survives and still works.
      assert.ok(active.browser.connected);
      assert.throws(() => manager.getSession(idle.sessionId));
    });

    it('does not reap a session touched after the scan but before close (no TOCTOU)', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});
      // Make it look idle so it becomes a reap candidate.
      session.lastActivityAt = Date.now() - 60_000;

      // Hold the session mutex, start the reap (it will block re-verifying
      // under the lock), then touch the session and release. The re-check must
      // see the fresh activity and skip the close.
      const guard = await session.mutex.acquire();
      const reapPromise = manager.reapIdleSessions(30_000);
      await new Promise(r => setTimeout(r, 20));
      manager.touchSession(session.sessionId);
      guard.dispose();

      const reaped = await reapPromise;
      assert.strictEqual(
        reaped,
        0,
        'freshly touched session must not be reaped',
      );
      assert.strictEqual(manager.sessionCount, 1);
    });

    it('reapIdleSessions respects tab activity (session used via its tabs is kept)', async () => {
      const manager = createManager();
      const session = await manager.createSession({headless: true});
      // Session-level timestamp is old, but a tab is touched right before
      // reaping, so the max(session, tab) activity is fresh.
      session.lastActivityAt = Date.now() - 60_000;
      session.context.touchSelectedPage();

      const reaped = await manager.reapIdleSessions(30_000);
      assert.strictEqual(reaped, 0, 'tab activity keeps the session alive');
      assert.strictEqual(manager.sessionCount, 1);
    });

    it('closeIdleTabsForAll closes idle tabs across sessions without dropping sessions', async () => {
      const manager = createManager();
      const a = await manager.createSession({headless: true});
      const b = await manager.createSession({headless: true});
      // Give each session a background tab.
      await a.context.newPage();
      await b.context.newPage();
      assert.strictEqual(a.context.getPageCount(), 2);
      assert.strictEqual(b.context.getPageCount(), 2);

      const closed = await manager.closeIdleTabsForAll(0);
      assert.strictEqual(closed, 2, 'one background tab closed per session');
      assert.strictEqual(manager.sessionCount, 2, 'sessions are not dropped');
      assert.strictEqual(a.context.getPageCount(), 1);
      assert.strictEqual(b.context.getPageCount(), 1);
    });
  });

  describe('session isolation hardening', () => {
    it('never resolves a foreign session id', async () => {
      const manager = createManager();
      const a = await manager.createSession({headless: true});
      const b = await manager.createSession({headless: true});

      assert.notStrictEqual(a.sessionId, b.sessionId);
      // Each id resolves only to its own context/browser.
      assert.strictEqual(manager.getSession(a.sessionId).context, a.context);
      assert.strictEqual(manager.getSession(b.sessionId).context, b.context);
      assert.notStrictEqual(a.context, b.context);
      assert.notStrictEqual(a.browser, b.browser);
    });

    it('a tab opened in one session is invisible to another', async () => {
      const manager = createManager();
      const a = await manager.createSession({headless: true});
      const b = await manager.createSession({headless: true});

      // Open extra tabs in A only.
      await a.context.newPage();
      await a.context.newPage();
      assert.strictEqual(a.context.getPageCount(), 3);
      // B is untouched and still single-tab.
      assert.strictEqual(b.context.getPageCount(), 1);

      // A's pageId 3 must not resolve to anything in B.
      const aPage3 = a.context.getPageById(3);
      assert.ok(aPage3);
      assert.throws(() => b.context.getPageById(3));
      // B's selected page is not any of A's pages.
      assert.notStrictEqual(b.context.getSelectedPage(), aPage3);
    });
  });

  describe('owner-based isolation', () => {
    it('an owner cannot resolve another owner session (same generic error)', async () => {
      const manager = createManager();
      const mine = await manager.createSession({headless: true, ownerId: 'me'});
      const theirs = await manager.createSession({
        headless: true,
        ownerId: 'them',
      });

      // I can reach my own session.
      assert.strictEqual(manager.getSession(mine.sessionId, 'me'), mine);
      // I cannot reach theirs; it looks exactly like a non-existent session.
      assert.throws(
        () => manager.getSession(theirs.sessionId, 'me'),
        /not found/i,
      );
      // The error must not reveal MY other sessions or any id I did not pass.
      try {
        manager.getSession(theirs.sessionId, 'me');
      } catch (e) {
        assert.doesNotMatch((e as Error).message, new RegExp(mine.sessionId));
      }
    });

    it('errors for unknown and foreign ids are indistinguishable', async () => {
      const manager = createManager();
      const theirs = await manager.createSession({
        headless: true,
        ownerId: 'them',
      });
      let foreignErr = '';
      let unknownErr = '';
      try {
        manager.getSession(theirs.sessionId, 'me');
      } catch (e) {
        foreignErr = (e as Error).message;
      }
      try {
        manager.getSession('deadbeef', 'me');
      } catch (e) {
        unknownErr = (e as Error).message;
      }
      // Same shape (only the id differs) so ownership can't be probed.
      assert.strictEqual(
        foreignErr.replace(theirs.sessionId, 'X'),
        unknownErr.replace('deadbeef', 'X'),
      );
    });

    it('listSessions only returns the owner sessions', async () => {
      const manager = createManager();
      const a1 = await manager.createSession({headless: true, ownerId: 'a'});
      await manager.createSession({headless: true, ownerId: 'a'});
      await manager.createSession({headless: true, ownerId: 'b'});

      const aList = manager.listSessions('a');
      assert.strictEqual(aList.length, 2);
      const bList = manager.listSessions('b');
      assert.strictEqual(bList.length, 1);
      // No id from 'a' leaks into 'b' list.
      assert.ok(!bList.some(s => s.sessionId === a1.sessionId));
    });

    it('closeSession refuses to close a foreign session', async () => {
      const manager = createManager();
      const theirs = await manager.createSession({
        headless: true,
        ownerId: 'them',
      });
      await assert.rejects(
        () => manager.closeSession(theirs.sessionId, 'me'),
        /not found/i,
      );
      // Still alive for its real owner.
      assert.ok(theirs.browser.connected);
      assert.strictEqual(manager.sessionCount, 1);
      await manager.closeSession(theirs.sessionId, 'them');
      assert.strictEqual(manager.sessionCount, 0);
    });

    it('a caller without an owner cannot reach owned sessions', async () => {
      const manager = createManager();
      const owned = await manager.createSession({
        headless: true,
        ownerId: 'them',
      });
      assert.throws(() => manager.getSession(owned.sessionId));
      assert.deepStrictEqual(manager.listSessions(), []);
    });
  });

  describe('persistence and reconnection', () => {
    const tempRoots: string[] = [];

    async function makeRegistry(): Promise<SessionRegistry> {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'session-manager-persist-'),
      );
      tempRoots.push(root);
      return new SessionRegistry(root);
    }

    function persistManager(registry: SessionRegistry): SessionManager {
      const m = new SessionManager(contextOptions, {
        registry,
        detached: true,
      });
      managers.push(m);
      return m;
    }

    afterEach(async () => {
      // Detached Chrome may still be flushing its profile when we tear down,
      // which makes a single rm race with ENOTEMPTY. Close the managers first
      // (kills the browsers), then remove with a brief retry.
      for (const m of managers) {
        await m.closeAllSessions().catch(() => {
          // best-effort; teardown continues regardless
        });
      }
      managers.length = 0;
      for (const root of tempRoots) {
        await rmWithRetry(root);
      }
      tempRoots.length = 0;
    });

    it('persists a detached session to the registry', async () => {
      const registry = await makeRegistry();
      const manager = persistManager(registry);
      const session = await manager.createSession({
        headless: true,
        label: 'persisted',
      });

      assert.ok(
        session.wsEndpoint,
        'detached session should expose wsEndpoint',
      );
      const persisted = await registry.list();
      assert.strictEqual(persisted.length, 1);
      assert.strictEqual(persisted[0].sessionId, session.sessionId);
      assert.strictEqual(persisted[0].label, 'persisted');
      assert.strictEqual(persisted[0].wsEndpoint, session.wsEndpoint);
    });

    it('detach keeps the browser alive and a new manager reconnects', async () => {
      const registry = await makeRegistry();
      const manager = persistManager(registry);
      const session = await manager.createSession({
        headless: true,
      });
      const originalId = session.sessionId;
      const browserProcess = session.browser.process();

      // Simulate the host shutting down: detach without killing the browser.
      await manager.detachAllSessions();
      assert.strictEqual(manager.sessionCount, 0);
      // Registry entry survives.
      assert.strictEqual((await registry.list()).length, 1);
      // The browser process is still alive.
      assert.strictEqual(browserProcess?.killed ?? false, false);

      // A fresh manager restores it from disk.
      const manager2 = persistManager(registry);
      const restored = await manager2.restoreSessions();
      assert.strictEqual(restored, 1);
      assert.strictEqual(manager2.sessionCount, 1);
      const reconnected = manager2.getSession(originalId);
      assert.strictEqual(reconnected.sessionId, originalId);
      assert.ok(reconnected.browser.connected);

      // Cleanup: real close removes registry + kills browser.
      await manager2.closeSession(originalId);
      assert.strictEqual((await registry.list()).length, 0);
    });

    it('garbage-collects dead registry entries on restore', async () => {
      const registry = await makeRegistry();
      // Persist a bogus session whose browser is not running.
      await registry.save({
        sessionId: 'deadbe01',
        wsEndpoint: 'ws://127.0.0.1:1/devtools/browser/deadbe01',
        userDataDir: registry.profileDir('deadbe01'),
        createdAt: new Date().toISOString(),
      });

      const manager = persistManager(registry);
      const restored = await manager.restoreSessions();
      assert.strictEqual(restored, 0);
      assert.strictEqual(manager.sessionCount, 0);
      // Dead entry is purged.
      assert.strictEqual((await registry.list()).length, 0);
    });

    it('closeSession removes the persisted registry entry', async () => {
      const registry = await makeRegistry();
      const manager = persistManager(registry);
      const session = await manager.createSession({
        headless: true,
      });
      assert.strictEqual((await registry.list()).length, 1);
      await manager.closeSession(session.sessionId);
      assert.strictEqual((await registry.list()).length, 0);
    });
  });
});
