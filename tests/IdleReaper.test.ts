/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {IdleReaper} from '../src/IdleReaper.js';
import type {ReapableSessions} from '../src/IdleReaper.js';

function fakeSessions(overrides: Partial<ReapableSessions> = {}): {
  sessions: ReapableSessions;
  calls: {tabIdleMs: number[]; sessionIdleMs: number[]};
} {
  const calls = {tabIdleMs: [] as number[], sessionIdleMs: [] as number[]};
  const sessions: ReapableSessions = {
    closeIdleTabsForAll: async ms => {
      calls.tabIdleMs.push(ms);
      return 0;
    },
    reapIdleSessions: async ms => {
      calls.sessionIdleMs.push(ms);
      return 0;
    },
    ...overrides,
  };
  return {sessions, calls};
}

describe('IdleReaper', () => {
  it('tick closes idle tabs then idle sessions with the configured thresholds', async () => {
    const {sessions, calls} = fakeSessions();
    const reaper = new IdleReaper(sessions, {
      tabIdleMs: 1000,
      sessionIdleMs: 5000,
    });
    await reaper.tick();
    assert.deepStrictEqual(calls.tabIdleMs, [1000]);
    assert.deepStrictEqual(calls.sessionIdleMs, [5000]);
  });

  it('does not overlap ticks (a slow tick blocks the next)', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const {sessions} = fakeSessions({
      closeIdleTabsForAll: async () => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise(r => setTimeout(r, 20));
        active--;
        return 0;
      },
    });
    const reaper = new IdleReaper(sessions, {
      tabIdleMs: 1,
      sessionIdleMs: 1,
    });
    await Promise.all([reaper.tick(), reaper.tick(), reaper.tick()]);
    assert.strictEqual(maxConcurrent, 1, 'ticks must not overlap');
  });

  it('never throws out of a tick even if a session op fails', async () => {
    const {sessions} = fakeSessions({
      closeIdleTabsForAll: async () => {
        throw new Error('boom');
      },
    });
    const reaper = new IdleReaper(sessions, {tabIdleMs: 1, sessionIdleMs: 1});
    await assert.doesNotReject(() => reaper.tick());
  });

  it('start is idempotent and stop clears the timer', () => {
    const {sessions} = fakeSessions();
    const reaper = new IdleReaper(sessions, {
      tabIdleMs: 1000,
      sessionIdleMs: 1000,
      intervalMs: 10_000,
    });
    reaper.start();
    reaper.start(); // no throw, no second timer
    reaper.stop();
    reaper.stop(); // no throw
    assert.ok(true);
  });
});
