/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {TARGET_PARAM} from '../../src/flows/element-target.js';
import type {FlowAction} from '../../src/flows/flow-model.js';
import {
  buildAutoDraft,
  summarizeJourney,
} from '../../src/flows/journey-summarizer.js';

function nav(url: string): FlowAction {
  return {tool: 'navigate_page', params: {url}};
}
function fill(name: string, value = 'x'): FlowAction {
  return {
    tool: 'fill',
    params: {uid: '1', value, [TARGET_PARAM]: {role: 'textbox', name}},
  };
}
function click(name: string): FlowAction {
  return {
    tool: 'click',
    params: {uid: '2', [TARGET_PARAM]: {role: 'button', name}},
  };
}

describe('journey-summarizer', () => {
  it('segments a journey at navigation boundaries', () => {
    const steps = summarizeJourney([
      nav('https://app.test/login'),
      fill('Email'),
      fill('Password'),
      click('Sign in'),
      nav('https://app.test/dashboard'),
      click('New item'),
    ]);
    assert.strictEqual(steps.length, 2);
    assert.match(steps[0].name, /^open-app-test/);
    assert.match(steps[1].name, /^open-app-test/);
  });

  it('gives each step a short description from its element targets', () => {
    const steps = summarizeJourney([
      nav('https://app.test/login'),
      fill('Email'),
      click('Sign in'),
    ]);
    assert.strictEqual(steps.length, 1);
    const desc = steps[0].description ?? '';
    assert.match(desc, /Go to app\.test/);
    // Mentions a labelled interaction.
    assert.match(desc, /Email|Sign in/);
  });

  it('builds a draft with a general description listing the phases', () => {
    const draft = buildAutoDraft('auto-app-test-x', [
      nav('https://app.test/login'),
      fill('Email'),
      click('Sign in'),
      nav('https://app.test/home'),
    ]);
    assert.strictEqual(draft.name, 'auto-app-test-x');
    assert.match(
      draft.description,
      /Auto-recorded browser journey on app\.test/,
    );
    assert.match(draft.description, /->/); // phase arrow
    assert.ok(draft.steps.length >= 2);
    // Every step carries a description.
    assert.ok(
      draft.steps.every(
        s => typeof s.description === 'string' && s.description,
      ),
    );
  });

  it('falls back to a single journey step when there is no navigation', () => {
    const draft = buildAutoDraft('auto-x', [click('A'), click('B')]);
    assert.strictEqual(draft.steps.length, 1);
    assert.ok(draft.steps[0].actions.length === 2);
  });

  it('names a non-nav-led segment after its dominant verb', () => {
    // A journey that starts WITHOUT a navigation (buffer trimmed): first
    // segment is interaction-only.
    const steps = summarizeJourney([fill('Email'), click('Save')]);
    assert.strictEqual(steps.length, 1);
    assert.match(steps[0].name, /fill|interact|submit/);
  });
});
