/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it, beforeEach, afterEach} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executablePath} from 'puppeteer';

/**
 * End-to-end coverage of the experimental flow subsystem through the real MCP
 * server: the `flow` tool is gated by the flag, actions are recorded, a flow is
 * saved to a temp project (with .env), listed, validated and replayed.
 */
describe('flow e2e', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-e2e-'));
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
        ...extraArgs,
      ],
    });
    const client = new Client(
      {name: 'flow-e2e', version: '1.0.0'},
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
    return content[0].text;
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

  it('does not expose the flow tool when the flag is off', async () => {
    await withClient(async client => {
      const {tools} = await client.listTools();
      assert.strictEqual(
        tools.find(t => t.name === 'flow'),
        undefined,
      );
    });
  });

  it('records, saves, lists, validates and replays a flow', async () => {
    await withClient(
      async client => {
        // flow tool is exposed and create_session nudges reuse.
        const {tools} = await client.listTools();
        assert.ok(tools.find(t => t.name === 'flow'));

        const sessionId = await createSession(client);

        // Record a couple of mutating actions. The FIRST browser interaction
        // teaches the model how to use flows / reuse an existing one.
        const firstTurn = await client.callTool({
          name: 'navigate_page',
          arguments: {
            sessionId,
            url: 'data:text/html,<h1>hi</h1>',
          },
        });
        const firstText = (
          firstTurn.content as Array<{type: string; text: string}>
        )[0].text;
        assert.match(firstText, /Flows: how to reuse and save journeys/);
        assert.match(firstText, /flow` op=list/);
        assert.match(firstText, /flow` op=exec/);
        // The teaching must tell the model to COMMIT flow files (regression
        // guard: the model previously concluded it should NOT commit them).
        assert.match(firstText, /COMMIT them/);
        assert.match(firstText, /never git add -A/);

        // Save the recording.
        const saved = await client.callTool({
          name: 'flow',
          arguments: {
            op: 'save',
            name: 'demo',
            description: 'demo flow',
            sessionId,
          },
        });
        assert.match(textOf(saved), /Saved flow "demo"/);

        // The file exists in the temp project and .env handling ran.
        const file = path.join(projectRoot, '.cdpflows', 'demo.cdp.ts');
        const source = await fs.readFile(file, 'utf8');
        assert.match(source, /defineFlow/);
        assert.match(source, /navigate_page/);

        // List shows it.
        const listed = await client.callTool({
          name: 'flow',
          arguments: {op: 'list'},
        });
        assert.match(textOf(listed), /\*\*demo\*\*/);

        // Validate passes.
        const validated = await client.callTool({
          name: 'flow',
          arguments: {op: 'validate', name: 'demo'},
        });
        assert.match(textOf(validated), /valid/);

        // Replay against a fresh session.
        const replaySession = await createSession(client);
        const replayed = await client.callTool({
          name: 'flow',
          arguments: {op: 'exec', name: 'demo', sessionId: replaySession},
        });
        assert.match(textOf(replayed), /passed/);
      },
      ['--experimental-flows', '--flows-project-root', projectRoot],
    );
  });

  it('exposes the raw draft and saves semantic steps', async () => {
    await withClient(
      async client => {
        const sessionId = await createSession(client);
        await client.callTool({
          name: 'navigate_page',
          arguments: {sessionId, url: 'data:text/html,<h1>a</h1>'},
        });
        await client.callTool({
          name: 'navigate_page',
          arguments: {sessionId, url: 'data:text/html,<h1>b</h1>'},
        });

        // Draft exposes the raw recorded actions as JSON.
        const draft = await client.callTool({
          name: 'flow',
          arguments: {op: 'draft', sessionId},
        });
        assert.match(textOf(draft), /2 action\(s\)/);
        assert.match(textOf(draft), /navigate_page/);

        // Save with a semantic step decomposition.
        const steps = JSON.stringify([
          {
            name: 'first',
            description: 'go to a',
            actions: [
              {
                tool: 'navigate_page',
                params: {url: 'data:text/html,<h1>a</h1>'},
              },
            ],
          },
          {
            name: 'second',
            actions: [
              {
                tool: 'navigate_page',
                params: {url: 'data:text/html,<h1>b</h1>'},
              },
            ],
          },
        ]);
        const saved = await client.callTool({
          name: 'flow',
          arguments: {op: 'save', name: 'semantic', sessionId, steps},
        });
        assert.match(textOf(saved), /Saved flow "semantic"/);
        assert.match(textOf(saved), /2 step\(s\)/);

        // The stored file reflects the semantic steps, not a single "main".
        const source = await fs.readFile(
          path.join(projectRoot, '.cdpflows', 'semantic.cdp.ts'),
          'utf8',
        );
        assert.match(source, /"first"/);
        assert.match(source, /"second"/);
        assert.doesNotMatch(source, /"main"/);
      },
      ['--experimental-flows', '--flows-project-root', projectRoot],
    );
  });
});
