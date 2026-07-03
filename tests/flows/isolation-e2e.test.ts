/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import process from 'node:process';
import {describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executablePath} from 'puppeteer';

/**
 * End-to-end owner isolation through the real MCP server. Two logical owners
 * share one server (as pi sessions share one subprocess). Owner A must never
 * see, operate, or close owner B's chrome sessions. The owner id travels as
 * the reserved `__mcpClientId` arg the broker injects — invisible to the model.
 */
describe('owner isolation e2e', () => {
  const OWNER = '__mcpClientId';

  async function withClient(
    cb: (client: Client) => Promise<void>,
  ): Promise<void> {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [
        'build/src/index.js',
        '--headless',
        '--isolated',
        '--executable-path',
        process.env.PUPPETEER_EXECUTABLE_PATH || executablePath(),
      ],
    });
    const client = new Client(
      {name: 'iso-e2e', version: '1.0.0'},
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

  async function createSession(client: Client, owner: string): Promise<string> {
    const result = await client.callTool({
      name: 'create_session',
      arguments: {headless: true, [OWNER]: owner},
    });
    const match = textOf(result).match(/\*\*sessionId\*\*: `([^`]+)`/);
    assert.ok(match, `no sessionId in: ${textOf(result)}`);
    return match[1];
  }

  it('one owner cannot see, operate or close another owner session', async () => {
    await withClient(async client => {
      const sessionA = await createSession(client, 'owner-A');
      const sessionB = await createSession(client, 'owner-B');
      assert.notStrictEqual(sessionA, sessionB);

      // list_sessions is scoped: A sees only A.
      const listA = await client.callTool({
        name: 'list_sessions',
        arguments: {[OWNER]: 'owner-A'},
      });
      assert.match(textOf(listA), new RegExp(sessionA));
      assert.doesNotMatch(textOf(listA), new RegExp(sessionB));
      assert.match(textOf(listA), /Total sessions: 1/);

      // A cannot navigate B's session — looks like it does not exist.
      const nav = await client.callTool({
        name: 'navigate_page',
        arguments: {
          sessionId: sessionB,
          url: 'data:text/html,<h1>x</h1>',
          [OWNER]: 'owner-A',
        },
      });
      assert.ok((nav as {isError?: boolean}).isError);
      assert.match(textOf(nav), /not found/i);
      // The error must not leak any other id (only the one A supplied).
      assert.doesNotMatch(textOf(nav), new RegExp(sessionA));

      // A cannot close B's session.
      const close = await client.callTool({
        name: 'close_session',
        arguments: {sessionId: sessionB, [OWNER]: 'owner-A'},
      });
      assert.ok((close as {isError?: boolean}).isError);
      assert.match(textOf(close), /not found/i);

      // B's session is still alive and usable by its real owner.
      const bNav = await client.callTool({
        name: 'navigate_page',
        arguments: {
          sessionId: sessionB,
          url: 'data:text/html,<h1>B</h1>',
          [OWNER]: 'owner-B',
        },
      });
      assert.ok(!(bNav as {isError?: boolean}).isError);
      assert.match(textOf(bNav), /Successfully navigated|B/);
    });
  });

  it('an unknown-owned id is indistinguishable from a non-existent one', async () => {
    await withClient(async client => {
      const sessionB = await createSession(client, 'owner-B');

      const foreign = await client.callTool({
        name: 'navigate_page',
        arguments: {
          sessionId: sessionB,
          url: 'data:text/html,<h1>x</h1>',
          [OWNER]: 'owner-A',
        },
      });
      const unknown = await client.callTool({
        name: 'navigate_page',
        arguments: {
          sessionId: 'deadbeef',
          url: 'data:text/html,<h1>x</h1>',
          [OWNER]: 'owner-A',
        },
      });
      // Same message shape (only the queried id differs).
      const norm = (s: string) =>
        s.replace(sessionB, 'X').replace('deadbeef', 'X');
      assert.strictEqual(norm(textOf(foreign)), norm(textOf(unknown)));
    });
  });
});
