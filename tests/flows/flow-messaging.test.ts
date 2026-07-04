/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {SECRET_STORE_FILE} from '../../src/flows/env-file.js';
import {
  autoSaveDescription,
  autoSaveNotice,
  commitGuidance,
  firstInteractionNotice,
  flowRelPath,
} from '../../src/flows/flow-messaging.js';
import {FLOW_FILE_EXTENSION, FLOWS_DIR} from '../../src/flows/flow-model.js';
import type {FlowSummary} from '../../src/flows/flow-store.js';

function summary(name: string, description = ''): FlowSummary {
  return {
    name,
    description,
    steps: 1,
    actions: 1,
    env: [],
    file: `${FLOWS_DIR}/${name}${FLOW_FILE_EXTENSION}`,
  };
}

describe('flow-messaging (single source of truth for model copy)', () => {
  it('derives the flow path from the flow-model constants', () => {
    assert.strictEqual(
      flowRelPath('login'),
      `${FLOWS_DIR}/login${FLOW_FILE_EXTENSION}`,
    );
  });

  it('commitGuidance leads with the affirmative action, then the caveat', () => {
    const g = commitGuidance('login');
    // Affirmative imperative appears before the "never git add -A" caveat.
    assert.ok(
      g.indexOf('MUST be committed') < g.indexOf('never git add -A'),
      'the affirmative commit instruction must precede the caveat',
    );
    assert.match(g, new RegExp(`git add ${FLOWS_DIR}/login`));
    // References the secret store via the shared constant, not a literal.
    assert.match(g, new RegExp(`gitignored ${SECRET_STORE_FILE}`));
    // No stacked-negation framing that once flipped the meaning.
    assert.doesNotMatch(g, /do NOT commit|throwaway|isolated/i);
  });

  it('commitGuidance without a name uses the generic <name> placeholder', () => {
    assert.match(
      commitGuidance(),
      new RegExp(`git add ${FLOWS_DIR}/<name>\\${FLOW_FILE_EXTENSION}`),
    );
  });

  it('autoSaveNotice embeds the canonical commit guidance verbatim', () => {
    const notice = autoSaveNotice('login', 3, '/repo/.cdpflows/login.cdp.ts');
    assert.match(notice, /reusable browser flow "login"/);
    assert.match(notice, /flow op=exec/);
    // The commit guidance is reused, not re-authored: substring-identical.
    assert.ok(notice.includes(commitGuidance('login')));
  });

  it('firstInteractionNotice reuses the same commit guidance and lists flows', () => {
    const notice = firstInteractionNotice([summary('login', 'logs in')]);
    assert.match(notice, /flow` op=list/);
    assert.match(notice, /flow` op=exec/);
    assert.match(notice, /Existing flows in this project/);
    assert.match(notice, /login \(logs in\)/);
    // Embeds the shared commit guidance verbatim (no divergence).
    assert.ok(notice.includes(commitGuidance()));
  });

  it('firstInteractionNotice frames recording as passive (no mid-task nudging)', () => {
    // Regression: an imperative "call op=list BEFORE building a journey" made
    // the model call flow tools too frequently during ordinary navigation.
    const notice = firstInteractionNotice([]);
    assert.match(notice, /PASSIVE/);
    assert.match(notice, /do NOT need to call the `flow` tool during ordinary/);
    assert.doesNotMatch(notice, /BEFORE building a multi-step journey/);
  });

  it('firstInteractionNotice states when there are no flows yet', () => {
    assert.match(firstInteractionNotice([]), /No saved flows yet/);
  });

  it('autoSaveDescription tells the model to commit the file', () => {
    assert.match(autoSaveDescription('new origin'), /Commit this file/);
    assert.match(autoSaveDescription('new origin'), /new origin/);
  });
});
