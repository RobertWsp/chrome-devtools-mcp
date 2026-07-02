/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import {describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executablePath} from 'puppeteer';

import type {ToolDefinition} from '../src/tools/ToolDefinition';

describe('e2e', () => {
  async function withClient(
    cb: (client: Client) => Promise<void>,
    extraArgs: string[] = [],
  ) {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [
        'build/src/index.js',
        '--headless',
        '--isolated',
        '--executable-path',
        executablePath(),
        ...extraArgs,
      ],
    });
    const client = new Client(
      {
        name: 'e2e-test',
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);
      await cb(client);
    } finally {
      await client.close();
    }
  }
  async function createSession(client: Client): Promise<string> {
    const result = await client.callTool({
      name: 'create_session',
      arguments: {headless: true},
    });
    const text = (result.content as Array<{type: string; text: string}>)[0]
      .text;
    const match = text.match(/\*\*sessionId\*\*: `([^`]+)`/);
    assert.ok(match, `could not parse sessionId from: ${text}`);
    return match[1];
  }

  it('calls a tool', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      const result = await client.callTool({
        name: 'list_pages',
        arguments: {sessionId},
      });
      assert.deepStrictEqual(result, {
        content: [
          {
            type: 'text',
            text: '# list_pages response\n## Pages\nabout:blank [selected]',
          },
        ],
      });
    });
  });

  it('calls a tool multiple times', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);
      let result = await client.callTool({
        name: 'list_pages',
        arguments: {sessionId},
      });
      result = await client.callTool({
        name: 'list_pages',
        arguments: {sessionId},
      });
      assert.deepStrictEqual(result, {
        content: [
          {
            type: 'text',
            text: '# list_pages response\n## Pages\nabout:blank [selected]',
          },
        ],
      });
    });
  });

  it('has all tools', async () => {
    await withClient(async client => {
      const {tools} = await client.listTools();
      const exposedNames = tools.map(t => t.name).sort();
      const files = fs.readdirSync('build/src/tools');
      const definedNames = [];
      for (const file of files) {
        if (file === 'ToolDefinition.js') {
          continue;
        }
        const fileTools = await import(`../src/tools/${file}`);
        for (const maybeTool of Object.values<ToolDefinition>(fileTools)) {
          if ('name' in maybeTool) {
            if (maybeTool.annotations?.conditions) {
              continue;
            }
            definedNames.push(maybeTool.name);
          }
        }
      }
      definedNames.sort();
      assert.deepStrictEqual(exposedNames, definedNames);
    });
  });

  it('has experimental extensions tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const clickAt = tools.find(t => t.name === 'install_extension');
        assert.ok(clickAt);
      },
      ['--category-extensions'],
    );
  });

  it('has experimental vision tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const clickAt = tools.find(t => t.name === 'click_at');
        assert.ok(clickAt);
      },
      ['--experimental-vision'],
    );
  });

  it('has experimental interop tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const getTabId = tools.find(t => t.name === 'get_tab_id');
        assert.ok(getTabId);
      },
      ['--experimental-interop-tools'],
    );
  });

  it('exposes switch_tab on demand once a session goes multi-tab', async () => {
    await withClient(async client => {
      const sessionId = await createSession(client);

      // Single tab: switch_tab is not exposed and pageIds are hidden.
      let {tools} = await client.listTools();
      assert.strictEqual(
        tools.find(t => t.name === 'switch_tab'),
        undefined,
        'switch_tab should be hidden with a single tab',
      );

      // Open a second tab.
      const opened = await client.callTool({
        name: 'new_page',
        arguments: {sessionId, url: 'about:blank'},
      });
      const openedText = (
        opened.content as Array<{type: string; text: string}>
      )[0].text;
      // Multi-tab notice is injected and pageIds are now visible.
      assert.match(openedText, /## Tab notices/);
      assert.match(openedText, /switch_tab/);

      // switch_tab is now exposed.
      ({tools} = await client.listTools());
      assert.ok(
        tools.find(t => t.name === 'switch_tab'),
        'switch_tab should be exposed once multi-tab',
      );
    });
  });
});
