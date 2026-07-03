/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {describe, it, beforeEach, afterEach} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executablePath} from 'puppeteer';

/**
 * Extensive end-to-end coverage of realistic flow journeys through the real
 * MCP server: multi-step navigation, form interaction with snapshot uids,
 * secret extraction + .env round-trip on replay, failure isolation,
 * partial replay, and the edit-then-revalidate repair loop.
 *
 * Each test drives the server exactly as an agent would: create a session,
 * call browser tools (which are recorded), then use the `flow` tool.
 */
describe('flow scenarios e2e', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-scn-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, {recursive: true, force: true});
  });

  async function withClient(
    cb: (client: Client) => Promise<void>,
    extraArgs: string[] = [],
  ): Promise<void> {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [
        'build/src/index.js',
        '--headless',
        '--isolated',
        '--executable-path',
        process.env.PUPPETEER_EXECUTABLE_PATH || executablePath(),
        '--experimental-flows',
        '--flows-project-root',
        projectRoot,
        ...extraArgs,
      ],
    });
    const client = new Client(
      {name: 'flow-scn', version: '1.0.0'},
      {capabilities: {}},
    );
    try {
      await client.connect(transport);
      await cb(client);
    } finally {
      await client.close();
    }
  }

  function textOf(result: unknown): string {
    const content = (result as {content: Array<{type: string; text: string}>})
      .content;
    return content.map(c => c.text ?? '').join('\n');
  }

  async function createSession(client: Client): Promise<string> {
    const result = await client.callTool({
      name: 'create_session',
      arguments: {headless: true},
    });
    const match = textOf(result).match(/\*\*sessionId\*\*: `([^`]+)`/);
    assert.ok(match, `no sessionId in: ${textOf(result)}`);
    return match[1];
  }

  async function createSessionAt(
    client: Client,
    root: string,
  ): Promise<string> {
    const result = await client.callTool({
      name: 'create_session',
      arguments: {headless: true, projectRoot: root},
    });
    const match = textOf(result).match(/\*\*sessionId\*\*: `([^`]+)`/);
    assert.ok(match, `no sessionId in: ${textOf(result)}`);
    return match[1];
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await client.callTool({name, arguments: args});
    return textOf(result);
  }

  async function readFlow(name: string): Promise<string> {
    return fs.readFile(
      path.join(projectRoot, '.cdpflows', `${name}.cdp.ts`),
      'utf8',
    );
  }

  // --- Scenario 1: multi-step navigation journey -------------------------
  it('records and replays a multi-step navigation journey', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>Home</h1><a href="data:text/html,<h1>Next</h1>">go</a>',
      });
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>Next</h1>',
      });

      const steps = JSON.stringify([
        {
          name: 'open-home',
          actions: [
            {
              tool: 'navigate_page',
              params: {url: 'data:text/html,<h1>Home</h1>'},
            },
          ],
        },
        {
          name: 'go-next',
          actions: [
            {
              tool: 'navigate_page',
              params: {url: 'data:text/html,<h1>Next</h1>'},
            },
          ],
        },
      ]);
      const saved = await call(client, 'flow', {
        op: 'save',
        name: 'nav-journey',
        sessionId,
        steps,
      });
      assert.match(saved, /Saved flow "nav-journey"/);
      assert.match(saved, /2 step\(s\)/);

      // Replay against a clean session.
      const replaySession = await createSession(client);
      const replayed = await call(client, 'flow', {
        op: 'exec',
        name: 'nav-journey',
        sessionId: replaySession,
      });
      assert.match(replayed, /Replay of "nav-journey": passed/);
      assert.match(replayed, /open-home: passed/);
      assert.match(replayed, /go-next: passed/);

      // The replayed session actually landed on Next.
      const pageState = await call(client, 'list_pages', {
        sessionId: replaySession,
      });
      assert.match(pageState, /Next|data:text\/html/);
    });
  });

  // --- Scenario 2: form interaction using snapshot uids ------------------
  it('records a snapshot-driven form fill and replays it', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      const form =
        'data:text/html,<form><input id="name" name="name"/>' +
        '<button onclick="document.title=document.getElementById(\'name\').value;return false;">save</button></form>';
      await call(client, 'navigate_page', {sessionId, url: form});
      const snap = await call(client, 'take_snapshot', {sessionId});
      // Extract the textbox + button uids from the snapshot text.
      const inputUid = snap.match(/uid=(\S+)\s+textbox/)?.[1];
      const buttonUid = snap.match(/uid=(\S+)\s+button/)?.[1];
      assert.ok(inputUid, `no textbox uid in snapshot:\n${snap}`);
      assert.ok(buttonUid, `no button uid in snapshot:\n${snap}`);

      await call(client, 'fill', {sessionId, uid: inputUid, value: 'Ada'});
      await call(client, 'click', {sessionId, uid: buttonUid});

      // Save with an explicit snapshot step so uids resolve on replay.
      const steps = JSON.stringify([
        {
          name: 'open-form',
          actions: [{tool: 'navigate_page', params: {url: form}}],
        },
        {
          name: 'fill-and-submit',
          actions: [
            {tool: 'take_snapshot', params: {}},
            {tool: 'fill', params: {uid: inputUid, value: 'Ada'}},
            {tool: 'click', params: {uid: buttonUid}},
          ],
        },
      ]);
      const saved = await call(client, 'flow', {
        op: 'save',
        name: 'form-fill',
        sessionId,
        steps,
      });
      assert.match(saved, /Saved flow "form-fill"/);

      // Replay on a fresh session; the snapshot inside the flow re-derives uids.
      const replaySession = await createSession(client);
      const replayed = await call(client, 'flow', {
        op: 'exec',
        name: 'form-fill',
        sessionId: replaySession,
      });
      assert.match(replayed, /Replay of "form-fill": passed/);

      // Verify the submit actually ran (title became the filled value).
      const title = await call(client, 'evaluate_script', {
        sessionId: replaySession,
        function: '() => document.title',
      });
      assert.match(title, /Ada/);
    });
  });

  // --- Scenario 3: secret extraction + .env round-trip on replay ---------
  it('extracts a password to .env and resolves it on replay', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      const page =
        'data:text/html,<input id="pw" type="password"/>' +
        '<button onclick="document.title=document.getElementById(\'pw\').value">login</button>';
      await call(client, 'navigate_page', {sessionId, url: page});
      const snap = await call(client, 'take_snapshot', {sessionId});
      // password inputs surface without an accessible name; grab any field uid.
      const uid = snap.match(
        /uid=(\S+)\s+(textbox|.*password.*|generic)/i,
      )?.[1];

      const steps = JSON.stringify([
        {
          name: 'login',
          actions: [
            {tool: 'navigate_page', params: {url: page}},
            {tool: 'take_snapshot', params: {}},
            {tool: 'fill', params: {uid: uid ?? '1_0', password: 'S3cr3t!'}},
          ],
        },
      ]);
      const saved = await call(client, 'flow', {
        op: 'save',
        name: 'login',
        sessionId,
        steps,
      });
      assert.match(saved, /Saved flow "login"/);

      // Flow file must NOT contain the raw secret; .env must.
      const source = await readFlow('login');
      assert.doesNotMatch(source, /S3cr3t!/);
      assert.match(source, /env\(/);
      const envFile = await fs.readFile(path.join(projectRoot, '.env'), 'utf8');
      assert.match(envFile, /S3cr3t!/);
      const gitignore = await fs.readFile(
        path.join(projectRoot, '.gitignore'),
        'utf8',
      );
      assert.match(gitignore, /^\.env$/m);

      // Validate stays green (no leaked secret).
      const validated = await call(client, 'flow', {
        op: 'validate',
        name: 'login',
      });
      assert.match(validated, /valid/);
      assert.doesNotMatch(validated, /INVALID/);
    });
  });

  // --- Scenario 4: failure isolation -------------------------------------
  it('stops at the first failing step and reports it', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>ok</h1>',
      });

      // A flow whose second step targets a non-existent element.
      const steps = JSON.stringify([
        {
          name: 'open',
          actions: [
            {
              tool: 'navigate_page',
              params: {url: 'data:text/html,<h1>ok</h1>'},
            },
          ],
        },
        {
          name: 'broken',
          actions: [{tool: 'click', params: {uid: '999_999', timeout: 1000}}],
        },
        {
          name: 'never',
          actions: [
            {tool: 'navigate_page', params: {url: 'data:text/html,<h1>x</h1>'}},
          ],
        },
      ]);
      await call(client, 'flow', {
        op: 'save',
        name: 'breaks',
        sessionId,
        steps,
      });

      const replaySession = await createSession(client);
      const replayed = await call(client, 'flow', {
        op: 'exec',
        name: 'breaks',
        sessionId: replaySession,
      });
      assert.match(replayed, /Replay of "breaks": failed/);
      assert.match(replayed, /open: passed/);
      assert.match(replayed, /broken: FAILED/);
      assert.doesNotMatch(replayed, /never: passed/);
      assert.match(replayed, /Use the browser tools to inspect and fix/);
    });
  });

  // --- Scenario 5: partial replay via stopAtStep ------------------------
  it('replays only up to stopAtStep', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>a</h1>',
      });
      const steps = JSON.stringify([
        {
          name: 'first',
          actions: [
            {tool: 'navigate_page', params: {url: 'data:text/html,<h1>a</h1>'}},
          ],
        },
        {
          name: 'second',
          actions: [
            {tool: 'navigate_page', params: {url: 'data:text/html,<h1>b</h1>'}},
          ],
        },
        {
          name: 'third',
          actions: [
            {tool: 'navigate_page', params: {url: 'data:text/html,<h1>c</h1>'}},
          ],
        },
      ]);
      await call(client, 'flow', {
        op: 'save',
        name: 'partial',
        sessionId,
        steps,
      });

      const replaySession = await createSession(client);
      const replayed = await call(client, 'flow', {
        op: 'exec',
        name: 'partial',
        sessionId: replaySession,
        stopAtStep: 'second',
      });
      assert.match(replayed, /first: passed/);
      assert.match(replayed, /second: passed/);
      assert.doesNotMatch(replayed, /third: passed/);
    });
  });

  // --- Scenario 6: edit-then-revalidate repair loop ----------------------
  it('detects a leaked secret introduced by a manual edit', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>ok</h1>',
      });
      await call(client, 'flow', {
        op: 'save',
        name: 'editable',
        sessionId,
        steps: JSON.stringify([
          {
            name: 'open',
            actions: [
              {
                tool: 'navigate_page',
                params: {url: 'data:text/html,<h1>ok</h1>'},
              },
            ],
          },
        ]),
      });
      // Baseline validate is green.
      assert.match(
        await call(client, 'flow', {op: 'validate', name: 'editable'}),
        /valid/,
      );

      // Simulate an agent Read+Write that injects a raw secret literal.
      const file = path.join(projectRoot, '.cdpflows', 'editable.cdp.ts');
      const source = await fs.readFile(file, 'utf8');
      const tampered = source.replace(
        'async () => {\n      await ctx.run("navigate_page"',
        'async () => {\n      await ctx.run("fill", {"password": "leaked-hunter2"});\n      await ctx.run("navigate_page"',
      );
      assert.notStrictEqual(
        tampered,
        source,
        'tamper replacement should apply',
      );
      await fs.writeFile(file, tampered, 'utf8');

      // The embedded harness must now flag the plaintext secret.
      const validated = await call(client, 'flow', {
        op: 'validate',
        name: 'editable',
      });
      assert.match(validated, /INVALID/);
      assert.match(validated, /secret/i);
    });
  });

  // --- Scenario 7: overwrite / re-save is idempotent ---------------------
  it('overwrites an existing flow on re-save', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>v1</h1>',
      });
      await call(client, 'flow', {
        op: 'save',
        name: 'ver',
        sessionId,
        description: 'first',
        steps: JSON.stringify([
          {
            name: 'one',
            actions: [
              {
                tool: 'navigate_page',
                params: {url: 'data:text/html,<h1>v1</h1>'},
              },
            ],
          },
        ]),
      });
      await call(client, 'flow', {
        op: 'save',
        name: 'ver',
        sessionId,
        description: 'second',
        steps: JSON.stringify([
          {
            name: 'one',
            actions: [
              {
                tool: 'navigate_page',
                params: {url: 'data:text/html,<h1>v2</h1>'},
              },
            ],
          },
          {
            name: 'two',
            actions: [
              {
                tool: 'navigate_page',
                params: {url: 'data:text/html,<h1>v2b</h1>'},
              },
            ],
          },
        ]),
      });

      const listed = await call(client, 'flow', {op: 'list'});
      // Exactly one "ver" entry, reflecting the second save (2 steps).
      const occurrences = listed.match(/\*\*ver\*\*/g) ?? [];
      assert.strictEqual(occurrences.length, 1);
      assert.match(listed, /2 step\(s\)/);
      const source = await readFlow('ver');
      assert.match(source, /"second"/);
      assert.match(source, /v2b/);
    });
  });

  // --- Scenario 8: recordings are isolated per session -------------------
  it('keeps recordings isolated between sessions', async () => {
    await withClient(async client => {
      const sessionA = await createSession(client);
      const sessionB = await createSession(client);
      await call(client, 'navigate_page', {
        sessionId: sessionA,
        url: 'data:text/html,<h1>A</h1>',
      });

      const draftA = await call(client, 'flow', {
        op: 'draft',
        sessionId: sessionA,
      });
      const draftB = await call(client, 'flow', {
        op: 'draft',
        sessionId: sessionB,
      });
      assert.match(draftA, /1 action\(s\)/);
      assert.match(draftB, /0 action\(s\)/);
    });
  });

  // --- Scenario 9: per-session projectRoot routes flows to the right repo -
  it('stores flows under the session declared projectRoot', async () => {
    const otherRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'flow-scn-other-'),
    );
    try {
      await withClient(async client => {
        // Session A uses the default root; session B declares otherRoot.
        const sessionB = await createSessionAt(client, otherRoot);
        await call(client, 'navigate_page', {
          sessionId: sessionB,
          url: 'data:text/html,<h1>B</h1>',
        });
        const saved = await call(client, 'flow', {
          op: 'save',
          name: 'routed',
          sessionId: sessionB,
          steps: JSON.stringify([
            {
              name: 'open',
              actions: [
                {
                  tool: 'navigate_page',
                  params: {url: 'data:text/html,<h1>B</h1>'},
                },
              ],
            },
          ]),
        });
        assert.match(saved, /Saved flow "routed"/);
        assert.match(
          saved,
          new RegExp(otherRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        );

        // The flow lives in otherRoot, NOT the default projectRoot.
        assert.ok(
          await fileExists(path.join(otherRoot, '.cdpflows', 'routed.cdp.ts')),
        );
        assert.ok(
          !(await fileExists(
            path.join(projectRoot, '.cdpflows', 'routed.cdp.ts'),
          )),
        );

        // op=list for that session only sees its project's flows.
        const listed = await call(client, 'flow', {
          op: 'list',
          sessionId: sessionB,
        });
        assert.match(listed, /\*\*routed\*\*/);
      });
    } finally {
      await fs.rm(otherRoot, {recursive: true, force: true});
    }
  });

  // --- Scenario 10: auto-save persists a journey without op=save ---------
  it('auto-saves a journey when navigating to a new origin', async () => {
    await withClient(async client => {
      const sessionId = await createSessionAt(client, projectRoot);
      // Interact on origin A (data URLs whose 24-char prefix differs), then
      // navigate to origin B -> journey boundary. Offline + deterministic.
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>commonprefix-one</h1>',
      });
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>commonprefix-two</h1>',
      });
      await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>DIFFERENTsite</h1>',
      });
      // Give the async auto-save a moment.
      await new Promise(r => setTimeout(r, 400));

      const listed = await call(client, 'flow', {op: 'list', sessionId});
      assert.match(listed, /\*\*auto-/);

      // The auto-saved file exists under a COMMITTABLE .cdpflows dir...
      const flowDir = path.join(projectRoot, '.cdpflows');
      const files = await fs.readdir(flowDir);
      assert.ok(
        files.some(f => f.startsWith('auto-') && f.endsWith('.cdp.ts')),
      );
      // ...and .env (secret store) is gitignored, but .cdpflows is NOT.
      const gitignore = await fs.readFile(
        path.join(projectRoot, '.gitignore'),
        'utf8',
      );
      assert.match(gitignore, /^\.env$/m);
      assert.doesNotMatch(gitignore, /\.cdpflows/);

      // The model is told about the auto-save on the next tool call.
      const nextTurn = await call(client, 'navigate_page', {
        sessionId,
        url: 'data:text/html,<h1>after</h1>',
      });
      assert.match(nextTurn, /Flow auto-save/);
      assert.match(nextTurn, /ACTION: commit this file/);
      assert.match(nextTurn, /git add \.cdpflows\//);
    });
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
