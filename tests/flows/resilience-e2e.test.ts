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
 * End-to-end resilience + isolation coverage through the real MCP server:
 *  - idle background tabs are reaped without dropping the session,
 *  - two concurrent sessions are isolated (one's tabs never affect the other),
 *  - the server keeps serving after an idle reap.
 */
describe('resilience e2e', () => {
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
      {name: 'resilience-e2e', version: '1.0.0'},
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

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return textOf(await client.callTool({name, arguments: args}));
  }

  it('reaps idle background tabs without dropping the session', async () => {
    await withClient(
      async client => {
        const sessionId = await createSession(client);
        // Open two more tabs. new_page always selects the new page, so the
        // LAST one (kept) is selected; the first extra + the initial
        // about:blank become idle background tabs to be reaped.
        await call(client, 'new_page', {
          sessionId,
          url: 'data:text/html,<h1>bgReaped</h1>',
        });
        await call(client, 'new_page', {
          sessionId,
          url: 'data:text/html,<h1>bgKept</h1>',
        });
        let pages = await call(client, 'list_pages', {sessionId});
        assert.match(pages, /bgReaped/);
        assert.match(pages, /bgKept/);

        // The reaper runs on a short interval; wait for it to close idle tabs.
        await new Promise(r => setTimeout(r, 3000));

        // The selected tab survives; the idle background tabs are gone. The
        // session itself is never torn down.
        pages = await call(client, 'list_pages', {sessionId});
        assert.match(pages, /bgKept \[selected\]|bgKept/);
        assert.doesNotMatch(pages, /bgReaped/);
        // Session still works (proves it was not torn down).
        const nav = await call(client, 'navigate_page', {
          sessionId,
          url: 'data:text/html,<h1>alive</h1>',
        });
        assert.match(nav, /Successfully navigated|alive/);
      },
      // tab idle 0.01min (~0.6s), session idle huge so only tabs are reaped.
      ['--tab-idle-minutes', '0.01', '--session-idle-minutes', '9999'],
    );
  });

  it('isolates two concurrent sessions (tabs and lifecycle)', async () => {
    await withClient(async client => {
      const a = await createSession(client);
      const b = await createSession(client);

      await call(client, 'new_page', {
        sessionId: a,
        url: 'data:text/html,<h1>A-only</h1>',
        background: true,
      });

      // B never sees A's tab.
      const bPages = await call(client, 'list_pages', {sessionId: b});
      assert.doesNotMatch(bPages, /A-only/);

      // Closing A's session leaves B fully functional.
      await call(client, 'close_session', {sessionId: a});
      const bNav = await call(client, 'navigate_page', {
        sessionId: b,
        url: 'data:text/html,<h1>B-alive</h1>',
      });
      assert.match(bNav, /Successfully navigated|B-alive/);

      // A is gone; using it errors, but that error does not affect B or crash.
      const aResult = await client.callTool({
        name: 'list_pages',
        arguments: {sessionId: a},
      });
      assert.ok(
        (aResult as {isError?: boolean}).isError,
        'closed session should error',
      );
      // B still works after the error.
      const bAgain = await call(client, 'list_pages', {sessionId: b});
      assert.match(bAgain, /B-alive|data:text\/html/);
    });
  });
});
