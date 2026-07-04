/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SECRET_STORE_FILE} from './env-file.js';
import {FLOW_FILE_EXTENSION, FLOWS_DIR} from './flow-model.js';
import type {FlowSummary} from './flow-store.js';

/**
 * Single source of truth for every model-facing string about flows.
 *
 * Rationale: the same guidance (how to reuse a flow, and above all that flow
 * files are committable project source) was previously duplicated across the
 * auto-save notice, the first-interaction teaching, and the host MCP
 * description. Divergence between those copies is exactly what once made the
 * model conclude it should NOT commit a flow. Centralizing the copy here keeps
 * it byte-identical wherever it surfaces, and keeps path/filename literals
 * derived from the flow-model constants (no hardcoded `.cdpflows`/`.env`).
 *
 * Design note on tone: action strings LEAD with the affirmative imperative
 * ("commit this file"), then state caveats. Stacked negations
 * (draft/isolated/do-NOT) collapse into the opposite meaning for an LLM.
 */

/**
 * Section titles for the notice blocks appended to a tool response. Both share
 * the `Flows:` prefix so the model sees a consistent, recognizable heading.
 */
export const NOTICE_TITLES = {
  firstInteraction: 'Flows: how to reuse and save journeys',
  autoSave: 'Flows: journey auto-saved',
} as const;

/** Relative path of a flow file, e.g. `.cdpflows/login.cdp.ts`. */
export function flowRelPath(name: string): string {
  return `${FLOWS_DIR}/${name}${FLOW_FILE_EXTENSION}`;
}

/**
 * The one canonical commit instruction, reused by every notice. Leads with the
 * affirmative action, then the single scope caveat, then the safety note.
 * `name` tailors the exact `git add` path when known; omit it for the generic
 * `.cdpflows/<name>.cdp.ts` form used in onboarding.
 */
export function commitGuidance(name?: string): string {
  const addPath = name
    ? flowRelPath(name)
    : `${FLOWS_DIR}/<name>${FLOW_FILE_EXTENSION}`;
  return (
    `Flow files (${FLOWS_DIR}/*${FLOW_FILE_EXTENSION}) are project source and ` +
    `MUST be committed to the repository so they are reusable later. ` +
    `Run: git add ${addPath} && git commit. The only caveat is scope: stage ` +
    `just that path (never git add -A) so you do not also commit the user's ` +
    `unrelated work in progress. Secret values never live in the flow file; ` +
    `they are stored in a gitignored ${SECRET_STORE_FILE}, so committing it is safe.`
  );
}

/**
 * Notice surfaced (once) after a journey is auto-saved. Tells the model the
 * file exists, how to refine/replay it, and to commit it.
 */
export function autoSaveNotice(
  name: string,
  actions: number,
  file: string,
): string {
  return (
    `A reusable browser flow "${name}" (${actions} action(s)) was auto-saved to ` +
    `${file}. It is project source, not a throwaway or isolated artifact. ` +
    `You may rename/refine it with flow op=save and replay it with flow op=exec. ` +
    `${commitGuidance(name)}`
  );
}

/**
 * One-shot teaching surfaced on a session's first browser interaction: how to
 * reuse an existing flow before deriving a journey, how to save a new one, and
 * that flow files are committable. `flows` are the session's existing flows so
 * the model can act on them immediately.
 */
export function firstInteractionNotice(flows: FlowSummary[]): string {
  const lines = [
    'Flow recording is active for this session. Reusable browser journeys ' +
      `(e.g. login, setup) are stored as ${FLOW_FILE_EXTENSION} files under ` +
      `${FLOWS_DIR}/ and can be replayed instead of re-deriving every step ` +
      '(saving tokens).',
    '',
    'How to work with flows:',
    '1. BEFORE building a multi-step journey, check for an existing one: ' +
      'call `flow` op=list.',
    '2. If a matching flow exists, replay it with `flow` op=exec name=<name> ' +
      '(it stops at the first failing step and tells you how to repair it).',
    '3. Only if none fits, perform the journey with the browser tools, then ' +
      'save it: `flow` op=draft to read the recorded actions, regroup them ' +
      'into named steps, and `flow` op=save name=<name> with the steps JSON. ' +
      'Completed journeys are also auto-saved as `auto-*` files you can ' +
      'rename/refine.',
    `4. ${commitGuidance()}`,
  ];
  if (flows.length > 0) {
    lines.push(
      '',
      `Existing flows in this project (prefer reusing one): ${flows
        .map(f => `${f.name} (${f.description || 'no description'})`)
        .join('; ')}.`,
    );
  } else {
    lines.push('', 'No saved flows yet in this project.');
  }
  return lines.join('\n');
}

/** Description of an auto-saved flow, embedded in the saved file itself. */
export function autoSaveDescription(reason: string): string {
  return `Auto-saved reusable journey (${reason}). Commit this file; rename/refine with flow op=save.`;
}
