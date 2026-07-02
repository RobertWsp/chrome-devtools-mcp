/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {
  CreateSessionOptions,
  SessionInfo,
  SessionManager,
} from '../src/SessionManager.js';
import {SessionService} from '../src/SessionService.js';
import type {SessionLaunchDefaults} from '../src/SessionService.js';

const defaults: SessionLaunchDefaults = {
  channel: 'stable',
  chromeArgs: [],
  ignoreDefaultChromeArgs: [],
  devtools: false,
};

interface Recorder {
  created: CreateSessionOptions[];
  closed: string[];
  restoreCalls: number;
  detachCalls: number;
  closeAllCalls: number;
  gotoUrls: string[];
}

function fakeManager(overrides: Partial<Record<string, unknown>> = {}): {
  manager: SessionManager;
  rec: Recorder;
} {
  const rec: Recorder = {
    created: [],
    closed: [],
    restoreCalls: 0,
    detachCalls: 0,
    closeAllCalls: 0,
    gotoUrls: [],
  };
  const manager = {
    async createSession(options: CreateSessionOptions): Promise<SessionInfo> {
      rec.created.push(options);
      return {
        sessionId: 'sess1234',
        label: options.label,
        context: {
          getSelectedPage: () => ({
            goto: async (url: string) => {
              rec.gotoUrls.push(url);
            },
          }),
        },
      } as unknown as SessionInfo;
    },
    listSessions() {
      return (
        (overrides.listSessions as unknown[] | undefined) ?? [
          {
            sessionId: 'sess1234',
            label: 'demo',
            createdAt: '2025-01-01T00:00:00.000Z',
            connected: true,
          },
        ]
      );
    },
    async closeSession(id: string) {
      rec.closed.push(id);
    },
    async restoreSessions() {
      rec.restoreCalls++;
      return (overrides.restored as number | undefined) ?? 2;
    },
    async detachAllSessions() {
      rec.detachCalls++;
    },
    async closeAllSessions() {
      rec.closeAllCalls++;
    },
  } as unknown as SessionManager;
  return {manager, rec};
}

describe('SessionService', () => {
  describe('createSession', () => {
    it('forwards launch defaults and parses the viewport', async () => {
      const {manager, rec} = fakeManager();
      const service = new SessionService(manager, defaults);
      const body = await service.createSession({
        headless: true,
        viewport: '800x600',
        label: 'login',
      });

      assert.strictEqual(rec.created.length, 1);
      const opts = rec.created[0];
      assert.deepStrictEqual(opts.viewport, {width: 800, height: 600});
      assert.strictEqual(opts.headless, true);
      assert.strictEqual(opts.label, 'login');
      assert.strictEqual(opts.channel, 'stable');
      assert.match(body, /\*\*sessionId\*\*: `sess1234`/);
      assert.match(body, /\*\*label\*\*: login/);
    });

    it('navigates to url when provided', async () => {
      const {manager, rec} = fakeManager();
      const service = new SessionService(manager, defaults);
      await service.createSession({url: 'https://example.com'});
      assert.deepStrictEqual(rec.gotoUrls, ['https://example.com']);
    });

    it('rejects a malformed viewport before launching', async () => {
      const {manager, rec} = fakeManager();
      const service = new SessionService(manager, defaults);
      await assert.rejects(
        () => service.createSession({viewport: 'nope'}),
        /Invalid viewport/,
      );
      assert.strictEqual(rec.created.length, 0);
    });
  });

  describe('listSessions', () => {
    it('renders a session summary', async () => {
      const {manager} = fakeManager();
      const service = new SessionService(manager, defaults);
      const body = service.listSessions();
      assert.match(body, /Total sessions: 1/);
      assert.match(body, /\*\*sess1234\*\* \(demo\)/);
    });

    it('renders an empty state', async () => {
      const {manager} = fakeManager({listSessions: []});
      const service = new SessionService(manager, defaults);
      const body = service.listSessions();
      assert.match(body, /Total sessions: 0/);
      assert.match(body, /No active sessions/);
    });
  });

  describe('closeSession', () => {
    it('delegates to the manager', async () => {
      const {manager, rec} = fakeManager();
      const service = new SessionService(manager, defaults);
      const body = await service.closeSession('sess1234');
      assert.deepStrictEqual(rec.closed, ['sess1234']);
      assert.match(body, /closed successfully/);
    });
  });

  describe('persistence branching', () => {
    it('restoreSessions is a no-op when persistence is off', async () => {
      const {manager, rec} = fakeManager();
      const service = new SessionService(manager, defaults, {persist: false});
      assert.strictEqual(await service.restoreSessions(), 0);
      assert.strictEqual(rec.restoreCalls, 0);
    });

    it('restoreSessions delegates when persistence is on', async () => {
      const {manager, rec} = fakeManager({restored: 3});
      const service = new SessionService(manager, defaults, {persist: true});
      assert.strictEqual(await service.restoreSessions(), 3);
      assert.strictEqual(rec.restoreCalls, 1);
    });

    it('shutdown detaches when persisting', async () => {
      const {manager, rec} = fakeManager();
      const service = new SessionService(manager, defaults, {persist: true});
      await service.shutdown();
      assert.strictEqual(rec.detachCalls, 1);
      assert.strictEqual(rec.closeAllCalls, 0);
    });

    it('shutdown closes all when not persisting', async () => {
      const {manager, rec} = fakeManager();
      const service = new SessionService(manager, defaults, {persist: false});
      await service.shutdown();
      assert.strictEqual(rec.closeAllCalls, 1);
      assert.strictEqual(rec.detachCalls, 0);
    });
  });
});
