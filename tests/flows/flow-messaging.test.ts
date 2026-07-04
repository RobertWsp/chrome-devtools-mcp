/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {SECRET_STORE_FILE} from '../../src/flows/env-file.js';
import type {ExecutionResult} from '../../src/flows/flow-executor.js';
import {
  autoSaveNotice,
  commitGuidance,
  execResult,
  FLOW_GLYPHS,
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
  it('pins the FLOW_GLYPHS code points to the host status vocabulary', () => {
    // WIRE CONTRACT: these MUST equal termness SEMANTIC_STATUS_GLYPHS so the
    // host tints per-step output. The two live in separate repos and cannot
    // import each other; both sides pin the exact code points so a change on
    // one is caught here.
    assert.strictEqual(FLOW_GLYPHS.success, '\u2713'); // check
    assert.strictEqual(FLOW_GLYPHS.error, '\u2717'); // cross
    assert.strictEqual(FLOW_GLYPHS.skipped, '\u2298'); // circled-slash (cancelled)
    assert.strictEqual(FLOW_GLYPHS.info, '\u2139'); // info
  });

  it('execResult renders a full ledger: passed, failed, then skipped', () => {
    const result: ExecutionResult = {
      flow: 'f',
      status: 'failed',
      failedStepIndex: 1,
      steps: [
        {name: 'open', status: 'passed', actionsRun: 1},
        {
          name: 'login',
          status: 'failed',
          actionsRun: 0,
          failedAction: 'fill',
          error: 'no element',
        },
        {name: 'verify', status: 'skipped', actionsRun: 0},
      ],
    };
    const out = execResult('f', result);
    assert.match(out, new RegExp(`${FLOW_GLYPHS.success} open: passed`));
    assert.match(out, new RegExp(`${FLOW_GLYPHS.error} login: FAILED`));
    // The skipped step is shown (not silently dropped) with the ⊘ glyph.
    assert.match(out, new RegExp(`${FLOW_GLYPHS.skipped} verify: skipped`));
    assert.match(out, new RegExp(`${FLOW_GLYPHS.error} Step "login" failed`));
  });

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
    assert.match(notice, /Named flows \(prefer reusing one\)/);
    assert.match(notice, /login \(logs in\)/);
    // Embeds the shared commit guidance verbatim (no divergence).
    assert.ok(notice.includes(commitGuidance()));
  });

  it('firstInteractionNotice collapses auto-* drafts to a count (no spam)', () => {
    // Regression: the raw list repeated the boilerplate auto-save description
    // once per draft, flooding the notice.
    const notice = firstInteractionNotice([
      summary('login', 'logs in'),
      summary('auto-shop-test-20260101-000000', 'Auto-saved reusable journey.'),
      summary('auto-shop-test-20260101-000100', 'Auto-saved reusable journey.'),
      summary('auto-shop-test-20260101-000200', 'Auto-saved reusable journey.'),
    ]);
    // The named flow is shown; the three drafts collapse to a single count.
    assert.match(notice, /login \(logs in\)/);
    assert.match(notice, /3 unnamed auto-saved draft\(s\)/);
    // The boilerplate description is not repeated per draft.
    const occurrences = notice.match(/Auto-saved reusable journey/g) ?? [];
    assert.strictEqual(occurrences.length, 0);
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
});
