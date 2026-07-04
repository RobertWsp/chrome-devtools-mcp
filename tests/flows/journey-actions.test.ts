/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {FlowAction} from '../../src/flows/flow-model.js';
import {
  hostOf,
  isNavigation,
  navigationUrl,
  NAVIGATION_TOOLS,
  slugify,
} from '../../src/flows/journey-actions.js';

function action(
  tool: string,
  params: Record<string, unknown> = {},
): FlowAction {
  return {tool, params};
}

describe('journey-actions (SSoT for journey reasoning)', () => {
  it('recognizes navigation tools', () => {
    assert.ok(isNavigation(action('navigate_page', {url: 'x'})));
    assert.ok(isNavigation(action('new_page', {url: 'x'})));
    assert.ok(!isNavigation(action('click', {uid: '1'})));
    assert.ok(NAVIGATION_TOOLS.has('navigate_page'));
    assert.ok(NAVIGATION_TOOLS.has('new_page'));
  });

  it('extracts the navigation url only for navigation actions', () => {
    assert.strictEqual(
      navigationUrl(action('navigate_page', {url: 'https://a.test'})),
      'https://a.test',
    );
    assert.strictEqual(navigationUrl(action('click', {url: 'x'})), undefined);
    assert.strictEqual(navigationUrl(action('navigate_page', {})), undefined);
  });

  it('extracts a www-stripped host', () => {
    assert.strictEqual(
      hostOf(action('navigate_page', {url: 'https://www.example.com/login'})),
      'example.com',
    );
    assert.strictEqual(
      hostOf(action('new_page', {url: 'https://app.test:3000/x'})),
      'app.test:3000',
    );
  });

  it('falls back to a scheme+path stub for hostless URLs (data:)', () => {
    const host = hostOf(
      action('navigate_page', {url: 'data:text/html,<h1>hi</h1>'}),
    );
    assert.ok(host && host.startsWith('data:'));
  });

  it('returns undefined host for a non-navigation or bad URL', () => {
    assert.strictEqual(
      hostOf(action('click', {url: 'https://a.test'})),
      undefined,
    );
    assert.strictEqual(
      hostOf(action('navigate_page', {url: 'not a url'})),
      undefined,
    );
  });

  it('slugify makes a file-safe kebab slug with a length cap', () => {
    assert.strictEqual(slugify('Open App.Test / Login'), 'open-app-test-login');
    assert.strictEqual(slugify('https://x.com'), 'x-com');
    assert.strictEqual(slugify('---weird---'), 'weird');
    assert.strictEqual(slugify('a'.repeat(60)).length, 40);
    assert.strictEqual(slugify('abc', 2), 'ab');
  });
});
