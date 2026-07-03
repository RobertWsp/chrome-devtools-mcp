/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {FlowController} from '../../src/flows/FlowController.js';
import type {FlowService} from '../../src/flows/FlowService.js';
import type {Context} from '../../src/tools/ToolDefinition.js';

/** Minimal FlowService stub exposing only what the controller calls. */
function fakeService(flows: unknown[] = []) {
  return {
    list: async () => flows,
    readSource: async (name: string) => `source of ${name}`,
    validateStored: async () => ({
      valid: true,
      issues: [] as Array<{severity: string; message: string}>,
    }),
    draftRecording: (_sessionId: string) => ({
      name: 'draft',
      description: '',
      env: [],
      steps: [
        {
          name: 'recording',
          actions: [{tool: 'navigate_page', params: {url: 'x'}}],
        },
      ],
    }),
    saveRecording: async (
      _sessionId: string,
      name: string,
      _description: string,
      steps?: unknown,
    ) => ({
      file: `/flows/${name}.cdp.ts`,
      flow: {name, description: '', env: [], steps: (steps as unknown[]) ?? []},
      validation: {valid: true, issues: []},
    }),
    exec: async () => ({
      flow: 'demo',
      status: 'passed' as const,
      failedStepIndex: -1,
      steps: [{name: 'main', status: 'passed' as const, actionsRun: 2}],
    }),
    summarize: (flow: {name: string}) => `${flow.name}: summary`,
  } as unknown as FlowService;
}

const passthroughRunner = async <T>(
  _sessionId: string,
  run: (context: Context) => Promise<T>,
): Promise<T> => run({} as Context);

describe('FlowController', () => {
  it('list: empty state', async () => {
    const c = new FlowController(fakeService(), passthroughRunner);
    const out = await c.handle({op: 'list'});
    assert.match(out, /No saved flows yet/);
  });

  it('list: renders summaries', async () => {
    const c = new FlowController(
      fakeService([
        {name: 'login', description: 'demo', steps: 2, actions: 5, env: ['PW']},
      ]),
      passthroughRunner,
    );
    const out = await c.handle({op: 'list'});
    assert.match(out, /\*\*login\*\*/);
    assert.match(out, /env: PW/);
  });

  it('show: requires a name', async () => {
    const c = new FlowController(fakeService(), passthroughRunner);
    await assert.rejects(() => c.handle({op: 'show'}), /requires a flow name/);
  });

  it('show: returns fenced source', async () => {
    const c = new FlowController(fakeService(), passthroughRunner);
    const out = await c.handle({op: 'show', name: 'login'});
    assert.match(out, /```ts/);
    assert.match(out, /source of login/);
  });

  it('draft: requires a sessionId and returns JSON actions', async () => {
    const c = new FlowController(fakeService(), passthroughRunner);
    await assert.rejects(() => c.handle({op: 'draft'}), /requires a sessionId/);
    const out = await c.handle({op: 'draft', sessionId: 's'});
    assert.match(out, /1 action\(s\)/);
    assert.match(out, /navigate_page/);
  });

  it('save: rejects invalid steps JSON', async () => {
    const c = new FlowController(fakeService(), passthroughRunner);
    await assert.rejects(
      () => c.handle({op: 'save', name: 'x', sessionId: 's', steps: '{bad'}),
      /Invalid steps JSON/,
    );
  });

  it('save: persists and summarizes', async () => {
    const c = new FlowController(fakeService(), passthroughRunner);
    const out = await c.handle({op: 'save', name: 'login', sessionId: 's'});
    assert.match(out, /Saved flow "login"/);
    assert.match(out, /login: summary/);
  });

  it('exec: runs through the session runner', async () => {
    let ran = false;
    const runner = async <T>(
      _sessionId: string,
      run: (context: Context) => Promise<T>,
    ): Promise<T> => {
      ran = true;
      return run({} as Context);
    };
    const c = new FlowController(fakeService(), runner);
    const out = await c.handle({op: 'exec', name: 'login', sessionId: 's'});
    assert.ok(ran, 'session runner should be invoked');
    assert.match(out, /Replay of "login": passed/);
    assert.match(out, /All steps passed/);
  });

  it('exec: requires name and sessionId', async () => {
    const c = new FlowController(fakeService(), passthroughRunner);
    await assert.rejects(
      () => c.handle({op: 'exec', name: 'x'}),
      /requires a sessionId/,
    );
    await assert.rejects(
      () => c.handle({op: 'exec', sessionId: 's'}),
      /requires a flow name/,
    );
  });

  it('unknown op throws', async () => {
    const c = new FlowController(fakeService(), passthroughRunner);
    await assert.rejects(() => c.handle({op: 'bogus'}), /Unknown flow op/);
  });
});
