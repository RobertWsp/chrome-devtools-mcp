/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {logger} from './logger.js';
import type {
  Browser,
  ChromeReleaseChannel,
  LaunchOptions,
  Target,
} from './third_party/index.js';
import {puppeteer} from './third_party/index.js';

let browser: Browser | undefined;

function makeTargetFilter() {
  const ignoredPrefixes = new Set([
    'chrome://',
    'chrome-extension://',
    'chrome-untrusted://',
  ]);

  return function targetFilter(target: Target): boolean {
    if (target.url() === 'chrome://newtab/') {
      return true;
    }
    // Could be the only page opened in the browser.
    if (target.url().startsWith('chrome://inspect')) {
      return true;
    }
    for (const prefix of ignoredPrefixes) {
      if (target.url().startsWith(prefix)) {
        return false;
      }
    }
    return true;
  };
}

export async function ensureBrowserConnected(options: {
  browserURL?: string;
  wsEndpoint?: string;
  wsHeaders?: Record<string, string>;
  devtools: boolean;
  channel?: Channel;
  userDataDir?: string;
}) {
  const {channel} = options;
  if (browser?.connected) {
    return browser;
  }

  const connectOptions: Parameters<typeof puppeteer.connect>[0] = {
    targetFilter: makeTargetFilter(),
    defaultViewport: null,
    handleDevToolsAsPage: true,
  };

  if (options.wsEndpoint) {
    connectOptions.browserWSEndpoint = options.wsEndpoint;
    if (options.wsHeaders) {
      connectOptions.headers = options.wsHeaders;
    }
  } else if (options.browserURL) {
    connectOptions.browserURL = options.browserURL;
  } else if (channel || options.userDataDir) {
    const userDataDir = options.userDataDir;
    if (userDataDir) {
      // TODO: re-expose this logic via Puppeteer.
      const portPath = path.join(userDataDir, 'DevToolsActivePort');
      try {
        const fileContent = await fs.promises.readFile(portPath, 'utf8');
        const [rawPort, rawPath] = fileContent
          .split('\n')
          .map(line => {
            return line.trim();
          })
          .filter(line => {
            return !!line;
          });
        if (!rawPort || !rawPath) {
          throw new Error(`Invalid DevToolsActivePort '${fileContent}' found`);
        }
        const port = parseInt(rawPort, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
          throw new Error(`Invalid port '${rawPort}' found`);
        }
        const browserWSEndpoint = `ws://127.0.0.1:${port}${rawPath}`;
        connectOptions.browserWSEndpoint = browserWSEndpoint;
      } catch (error) {
        throw new Error(
          `Could not connect to Chrome in ${userDataDir}. Check if Chrome is running and remote debugging is enabled.`,
          {
            cause: error,
          },
        );
      }
    } else {
      if (!channel) {
        throw new Error('Channel must be provided if userDataDir is missing');
      }
      connectOptions.channel = (
        channel === 'stable' ? 'chrome' : `chrome-${channel}`
      ) as ChromeReleaseChannel;
    }
  } else {
    throw new Error(
      'Either browserURL, wsEndpoint, channel or userDataDir must be provided',
    );
  }

  logger('Connecting Puppeteer to ', JSON.stringify(connectOptions));
  try {
    browser = await puppeteer.connect(connectOptions);
  } catch (err) {
    throw new Error(
      'Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.',
      {
        cause: err,
      },
    );
  }
  logger('Connected Puppeteer');
  return browser;
}

interface McpLaunchOptions {
  acceptInsecureCerts?: boolean;
  executablePath?: string;
  channel?: Channel;
  userDataDir?: string;
  headless: boolean;
  isolated: boolean;
  logFile?: fs.WriteStream;
  viewport?: {
    width: number;
    height: number;
  };
  chromeArgs?: string[];
  ignoreDefaultChromeArgs?: string[];
  devtools: boolean;
  enableExtensions?: boolean;
  /**
   * When true the browser process survives the MCP host: it is not piped to
   * the host stdio and does not close on the host receiving SIGINT/SIGTERM/
   * SIGHUP. The caller is responsible for persisting the wsEndpoint so the
   * browser can be reconnected later.
   */
  detached?: boolean;
}

/**
 * Reconnects to a previously launched, still-running detached browser using a
 * persisted WebSocket endpoint. Throws if the endpoint is dead.
 */
export async function reconnectBrowser(wsEndpoint: string): Promise<Browser> {
  const connectOptions: Parameters<typeof puppeteer.connect>[0] = {
    browserWSEndpoint: wsEndpoint,
    targetFilter: makeTargetFilter(),
    defaultViewport: null,
    handleDevToolsAsPage: true,
  };
  logger('Reconnecting Puppeteer to detached browser', wsEndpoint);
  return await puppeteer.connect(connectOptions);
}

export async function launch(options: McpLaunchOptions): Promise<Browser> {
  const {channel, executablePath, headless, isolated, detached} = options;
  const profileDirName =
    channel && channel !== 'stable'
      ? `chrome-profile-${channel}`
      : 'chrome-profile';

  let userDataDir = options.userDataDir;
  if (!isolated && !userDataDir) {
    userDataDir = path.join(
      os.homedir(),
      '.cache',
      'chrome-devtools-mcp',
      profileDirName,
    );
    await fs.promises.mkdir(userDataDir, {
      recursive: true,
    });
  }

  const args: LaunchOptions['args'] = [
    ...(options.chromeArgs ?? []),
    '--hide-crash-restore-bubble',
  ];
  const ignoreDefaultArgs: LaunchOptions['ignoreDefaultArgs'] =
    options.ignoreDefaultChromeArgs ?? false;

  if (headless) {
    args.push('--screen-info={3840x2160}');
  }
  let puppeteerChannel: ChromeReleaseChannel | undefined;
  if (options.devtools) {
    args.push('--auto-open-devtools-for-tabs');
  }
  if (!executablePath) {
    puppeteerChannel =
      channel && channel !== 'stable'
        ? (`chrome-${channel}` as ChromeReleaseChannel)
        : 'chrome';
  }

  try {
    const browser = await puppeteer.launch({
      channel: puppeteerChannel,
      targetFilter: makeTargetFilter(),
      executablePath,
      defaultViewport: null,
      userDataDir,
      // A detached browser must expose a WS endpoint (pipe has no endpoint to
      // reconnect to) and must outlive the host process/signals.
      pipe: !detached,
      headless,
      args,
      ignoreDefaultArgs: ignoreDefaultArgs,
      acceptInsecureCerts: options.acceptInsecureCerts,
      handleDevToolsAsPage: true,
      enableExtensions: options.enableExtensions,
      ...(detached
        ? {handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false}
        : {}),
    });
    if (options.logFile) {
      // FIXME: we are probably subscribing too late to catch startup logs. We
      // should expose the process earlier or expose the getRecentLogs() getter.
      browser.process()?.stderr?.pipe(options.logFile);
      browser.process()?.stdout?.pipe(options.logFile);
    }
    if (options.viewport) {
      const [page] = await browser.pages();
      await page?.resize({
        contentWidth: options.viewport.width,
        contentHeight: options.viewport.height,
      });
    }
    return browser;
  } catch (error) {
    if (
      userDataDir &&
      (error as Error).message.includes('The browser is already running')
    ) {
      throw new Error(
        `The browser is already running for ${userDataDir}. Use --isolated to run multiple browser instances.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

export async function ensureBrowserLaunched(
  options: McpLaunchOptions,
): Promise<Browser> {
  if (browser?.connected) {
    return browser;
  }
  browser = await launch(options);
  return browser;
}

export type Channel = 'stable' | 'canary' | 'beta' | 'dev';
