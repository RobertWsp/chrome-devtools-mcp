/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {NetworkFormatter} from '../src/formatters/NetworkFormatter.js';
import {IDLE_TAB_TIMEOUT_MS} from '../src/McpContext.js';
import type {HTTPResponse} from '../src/third_party/index.js';
import type {TraceResult} from '../src/trace-processing/parse.js';

import {getMockRequest, html, withMcpContext} from './utils.js';

describe('McpContext', () => {
  it('list pages', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPage();
      await page.setContent(
        html`<button>Click me</button>
          <input
            type="text"
            value="Input"
          />`,
      );
      await context.createTextSnapshot();
      assert.ok(await context.getElementByUid('1_1'));
      await context.createTextSnapshot();
      await context.getElementByUid('1_1');
    });
  });

  it('can store and retrieve the latest performance trace', async () => {
    await withMcpContext(async (_response, context) => {
      const fakeTrace1 = {} as unknown as TraceResult;
      const fakeTrace2 = {} as unknown as TraceResult;
      context.storeTraceRecording(fakeTrace1);
      context.storeTraceRecording(fakeTrace2);
      assert.deepEqual(context.recordedTraces(), [fakeTrace2]);
    });
  });

  it('should update default timeout when cpu throttling changes', async () => {
    await withMcpContext(async (_response, context) => {
      const page = await context.newPage();
      const timeoutBefore = page.getDefaultTimeout();
      context.setCpuThrottlingRate(2);
      const timeoutAfter = page.getDefaultTimeout();
      assert(timeoutBefore < timeoutAfter, 'Timeout was less then expected');
    });
  });

  it('should update default timeout when network conditions changes', async () => {
    await withMcpContext(async (_response, context) => {
      const page = await context.newPage();
      const timeoutBefore = page.getDefaultNavigationTimeout();
      context.setNetworkConditions('Slow 3G');
      const timeoutAfter = page.getDefaultNavigationTimeout();
      assert(timeoutBefore < timeoutAfter, 'Timeout was less then expected');
    });
  });

  it('should call waitForEventsAfterAction with correct multipliers', async () => {
    await withMcpContext(async (_response, context) => {
      const page = await context.newPage();

      context.setCpuThrottlingRate(2);
      context.setNetworkConditions('Slow 3G');
      const stub = sinon.spy(context, 'getWaitForHelper');

      await context.waitForEventsAfterAction(async () => {
        // trigger the waiting only
      });

      sinon.assert.calledWithExactly(stub, page, 2, 10);
    });
  });

  it('should should detect open DevTools pages', async () => {
    await withMcpContext(
      async (_response, context) => {
        const page = await context.newPage();
        // TODO: we do not know when the CLI flag to auto open DevTools will run
        // so we need this until
        // https://github.com/puppeteer/puppeteer/issues/14368 is there.
        await new Promise(resolve => setTimeout(resolve, 5000));
        await context.createPagesSnapshot();
        assert.ok(context.getDevToolsPage(page));
      },
      {
        autoOpenDevTools: true,
      },
    );
  });
  it('should include network requests in structured content', async t => {
    await withMcpContext(async (response, context) => {
      const mockRequest = getMockRequest({
        url: 'http://example.com/api',
        stableId: 123,
      });

      sinon.stub(context, 'getNetworkRequests').returns([mockRequest]);
      sinon.stub(context, 'getNetworkRequestStableId').returns(123);

      response.setIncludeNetworkRequests(true);
      const result = await response.handle('test', context);

      t.assert.snapshot?.(JSON.stringify(result.structuredContent, null, 2));
    });
  });

  it('should include detailed network request in structured content', async t => {
    await withMcpContext(async (response, context) => {
      const mockRequest = getMockRequest({
        url: 'http://example.com/detail',
        stableId: 456,
      });

      sinon.stub(context, 'getNetworkRequestById').returns(mockRequest);
      sinon.stub(context, 'getNetworkRequestStableId').returns(456);

      response.attachNetworkRequest(456);
      const result = await response.handle('test', context);

      t.assert.snapshot?.(JSON.stringify(result.structuredContent, null, 2));
    });
  });

  it('should include file paths in structured content when saving to file', async t => {
    await withMcpContext(async (response, context) => {
      const mockRequest = getMockRequest({
        url: 'http://example.com/file-save',
        stableId: 789,
        hasPostData: true,
        postData: 'some detailed data',
        response: {
          status: () => 200,
          headers: () => ({'content-type': 'text/plain'}),
          buffer: async () => Buffer.from('some response data'),
        } as unknown as HTTPResponse,
      });

      sinon.stub(context, 'getNetworkRequestById').returns(mockRequest);
      sinon.stub(context, 'getNetworkRequestStableId').returns(789);

      // We stub NetworkFormatter.from to avoid actual file system writes and verify arguments
      const fromStub = sinon
        .stub(NetworkFormatter, 'from')
        .callsFake(async (_req, opts) => {
          // Verify we received the file paths
          assert.strictEqual(opts?.requestFilePath, '/tmp/req.txt');
          assert.strictEqual(opts?.responseFilePath, '/tmp/res.txt');
          // Return a dummy formatter that behaves as if it saved files
          // We need to create a real instance or mock one.
          // Since constructor is private, we can't easily new it up.
          // But we can return a mock object.
          return {
            toStringDetailed: () => 'Detailed string',
            toJSONDetailed: () => ({
              requestBody: '/tmp/req.txt',
              responseBody: '/tmp/res.txt',
            }),
          } as unknown as NetworkFormatter;
        });

      response.attachNetworkRequest(789, {
        requestFilePath: '/tmp/req.txt',
        responseFilePath: '/tmp/res.txt',
      });
      const result = await response.handle('test', context);

      t.assert.snapshot?.(JSON.stringify(result.structuredContent, null, 2));

      fromStub.restore();
    });
  });

  describe('tab lifecycle', () => {
    it('reports single vs multiple tabs', async () => {
      await withMcpContext(async (_response, context) => {
        assert.strictEqual(context.hasMultipleTabs(), false);
        assert.strictEqual(context.getPageCount(), 1);
        await context.newPage();
        assert.strictEqual(context.hasMultipleTabs(), true);
        assert.strictEqual(context.getPageCount(), 2);
      });
    });

    it('emits the multi-tab notice once, then not again', async () => {
      await withMcpContext(async (_response, context) => {
        assert.strictEqual(context.consumeMultiTabNotice(), undefined);
        await context.newPage();
        const first = context.consumeMultiTabNotice();
        assert.ok(first, 'first multi-tab call should return a notice');
        assert.match(first!, /switch_tab/);
        assert.strictEqual(
          context.consumeMultiTabNotice(),
          undefined,
          'notice should not repeat',
        );
      });
    });

    it('re-arms the multi-tab notice after returning to single tab', async () => {
      await withMcpContext(async (_response, context) => {
        const page = await context.newPage();
        assert.ok(context.consumeMultiTabNotice());
        const pageId = context.getPageId(page)!;
        await context.closePage(pageId);
        // Mirror the real request flow, which refreshes the page list.
        await context.createPagesSnapshot();
        assert.strictEqual(context.consumeMultiTabNotice(), undefined);
        await context.newPage();
        assert.ok(
          context.consumeMultiTabNotice(),
          'notice should fire again for a new second tab',
        );
      });
    });

    it('does not report the selected tab as idle', async () => {
      await withMcpContext(async (_response, context) => {
        await context.newPage();
        assert.deepStrictEqual(
          context.consumeIdleTabNotices(IDLE_TAB_TIMEOUT_MS),
          [],
        );
      });
    });

    it('reports a non-selected tab once it exceeds the idle threshold', async () => {
      await withMcpContext(async (_response, context) => {
        const first = context.getSelectedPage();
        const firstId = context.getPageId(first)!;
        await context.newPage();
        const notices = context.consumeIdleTabNotices(0);
        assert.strictEqual(notices.length, 1);
        assert.match(notices[0], new RegExp(`Tab ${firstId}`));
        assert.match(notices[0], /close_page/);
        assert.deepStrictEqual(context.consumeIdleTabNotices(0), []);
      });
    });

    it('resets the idle timer when the tab is touched', async () => {
      await withMcpContext(async (_response, context) => {
        const first = context.getSelectedPage();
        await context.newPage();
        assert.strictEqual(context.consumeIdleTabNotices(0).length, 1);
        // Touching resets last-activity to now, so a realistic threshold no
        // longer considers the tab idle.
        context.touchPage(first);
        assert.deepStrictEqual(
          context.consumeIdleTabNotices(IDLE_TAB_TIMEOUT_MS),
          [],
        );
      });
    });

    it('closeIdleTabs closes idle background tabs but keeps the selected one', async () => {
      await withMcpContext(async (_response, context) => {
        const first = context.getSelectedPage();
        // Open two more tabs; the last becomes selected.
        await context.newPage();
        const third = await context.newPage();
        assert.strictEqual(context.getPageCount(), 3);
        assert.ok(context.isPageSelected(third));

        // With a 0ms threshold every non-selected tab is idle.
        const closed = await context.closeIdleTabs(0);
        assert.strictEqual(closed, 2, 'both background tabs closed');
        assert.strictEqual(context.getPageCount(), 1);
        // The selected tab survives.
        assert.ok(context.isPageSelected(context.getSelectedPage()));
        // `first` was a background tab and is gone.
        assert.ok(first.isClosed());
      });
    });

    it('closeIdleTabs never closes the selected tab or drops below one', async () => {
      await withMcpContext(async (_response, context) => {
        // Single selected tab: nothing to close even at 0ms.
        const closed = await context.closeIdleTabs(0);
        assert.strictEqual(closed, 0);
        assert.strictEqual(context.getPageCount(), 1);
      });
    });

    it('closeIdleTabs keeps recently-touched background tabs', async () => {
      await withMcpContext(async (_response, context) => {
        const first = context.getSelectedPage();
        await context.newPage(); // second, becomes selected
        // `first` is a background tab; touch it so it is not idle.
        context.touchPage(first);
        const closed = await context.closeIdleTabs(IDLE_TAB_TIMEOUT_MS);
        assert.strictEqual(closed, 0);
        assert.strictEqual(context.getPageCount(), 2);
      });
    });

    it('lastActivityAt reflects the most recent touch', async () => {
      await withMcpContext(async (_response, context) => {
        const before = Date.now();
        context.touchSelectedPage();
        const last = context.lastActivityAt();
        assert.ok(last !== undefined && last >= before);
      });
    });

    it('the configured tabIdleTimeoutMs is the single source of truth for notice + reap', async () => {
      await withMcpContext(
        async (_response, context) => {
          // getter exposes the configured value (SSoT).
          assert.strictEqual(context.tabIdleTimeoutMs, 50);
          const first = context.getSelectedPage();
          await context.newPage(); // second, selected
          // `first` was touched at creation; wait past the 50ms threshold.
          await new Promise(r => setTimeout(r, 80));

          // Notice uses the configured default (no explicit arg).
          const notices = context.consumeIdleTabNotices();
          assert.strictEqual(notices.length, 1);
          assert.match(
            notices[0],
            new RegExp(`Tab ${context.getPageId(first)}`),
          );

          // Reap uses the same configured default and closes that tab.
          const closed = await context.closeIdleTabs();
          assert.strictEqual(closed, 1);
          assert.strictEqual(context.getPageCount(), 1);
        },
        {tabIdleTimeoutMs: 50},
      );
    });
  });
});
