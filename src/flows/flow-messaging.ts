/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SECRET_STORE_FILE} from './env-file.js';
import type {ExecutionResult, StepResult} from './flow-executor.js';
import type {Flow} from './flow-model.js';
import {countActions, FLOW_FILE_EXTENSION, FLOWS_DIR} from './flow-model.js';
import type {FlowSummary} from './flow-store.js';
import type {ValidationResult} from './flow-validator.js';

/**
 * Semantic status glyphs prefixing result lines. These MUST match the
 * vocabulary the host TUI paints by colour (termness `SEMANTIC_STATUS_GLYPHS`
 * / `SEMANTIC_STATUS_COLOR`): a body line beginning with one of these glyphs is
 * coloured success/error/dim/accent there. This is the wire contract that lets
 * the model AND the human get per-step colour feedback without the fork
 * emitting ANSI (the host strips it). Keep the code points in sync with that
 * table; the flow-messaging test pins them.
 */
export const FLOW_GLYPHS = {
  success: '\u2713', // ok, passed, saved-ok
  error: '\u2717', // failed
  skipped: '\u2298', // not run (stopped before this step)
  info: '\u2139', // neutral note (e.g. "saved to <file>")
} as const;

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
    'Flow recording is active and PASSIVE: your browser actions are recorded ' +
      'automatically in the background. Just do your browsing normally with the ' +
      'browser tools — you do NOT need to call the `flow` tool during ordinary ' +
      'navigation, and you should not interrupt a task to manage flows.',
    '',
    'Only reach for the `flow` tool in these specific cases:',
    '1. You are about to REPEAT a known multi-step journey (e.g. a login you ' +
      'have done before): call `flow` op=list once to see if a saved flow ' +
      'exists, and if so replay it with `flow` op=exec name=<name> instead of ' +
      're-deriving every step (saving tokens).',
    '2. You just FINISHED a reusable multi-step journey worth keeping: save it ' +
      'with `flow` op=draft then `flow` op=save. This is optional — completed ' +
      'journeys are also auto-saved as `auto-*` files you can refine later.',
    '',
    `When a ${FLOW_FILE_EXTENSION} file is created: ${commitGuidance()}`,
  ];
  if (flows.length > 0) {
    lines.push('', existingFlowsSummary(flows));
  } else {
    lines.push('', 'No saved flows yet in this project.');
  }
  return lines.join('\n');
}

/** Auto-saved drafts share a boilerplate name prefix. */
const AUTO_FLOW_PREFIX = 'auto-';
const MAX_LISTED_NAMED_FLOWS = 12;

/**
 * Compact one-line inventory of a project's flows for the onboarding notice.
 * NAMED flows (the ones worth reusing) are shown with their descriptions;
 * the auto-saved `auto-*` drafts all carry the same boilerplate description,
 * so they are collapsed to a single count instead of repeating that text once
 * per draft (the spam the raw list produced). Keeps the notice scannable.
 */
function existingFlowsSummary(flows: FlowSummary[]): string {
  const named = flows.filter(f => !f.name.startsWith(AUTO_FLOW_PREFIX));
  const autos = flows.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) {
    const shown = named
      .slice(0, MAX_LISTED_NAMED_FLOWS)
      .map(f => `${f.name} (${f.description || 'no description'})`)
      .join('; ');
    const overflow =
      named.length > MAX_LISTED_NAMED_FLOWS
        ? ` (+${named.length - MAX_LISTED_NAMED_FLOWS} more)`
        : '';
    parts.push(`Named flows (prefer reusing one): ${shown}${overflow}.`);
  }
  if (autos > 0) {
    parts.push(
      `${autos} unnamed auto-saved draft(s) also exist; run \`flow\` op=list to ` +
        'see them, or op=save to give a useful one a real name.',
    );
  }
  return parts.join('\n');
}

/** Description of an auto-saved flow, embedded in the saved file itself. */
export function autoSaveDescription(reason: string): string {
  return `Auto-saved reusable journey (${reason}). Commit this file; rename/refine with flow op=save.`;
}

/** One-line summary of a flow (name + step/action counts). */
export function flowSummaryLine(flow: Flow): string {
  return `${flow.name}: ${flow.steps.length} step(s), ${countActions(flow)} action(s)`;
}

/**
 * `op=list` result. Each flow is an `info`-glyph row so the host paints the
 * list in the neutral accent tone and the model scans names quickly.
 */
export function listResult(flows: FlowSummary[]): string {
  if (flows.length === 0) {
    return 'No saved flows yet. Actions are being recorded; use op=save to persist one.';
  }
  const lines = flows.map(
    f =>
      `${FLOW_GLYPHS.info} ${f.name} — ${f.description || 'no description'} ` +
      `(${f.steps} step(s), ${f.actions} action(s)` +
      `${f.env.length ? `, env: ${f.env.join(', ')}` : ''})`,
  );
  return `Saved flows:\n${lines.join('\n')}`;
}

/**
 * `op=save` result. Leads with a success glyph so the save reads as a distinct,
 * positive event (green in the host), not undifferentiated grey output.
 */
export function saveResult(
  name: string,
  file: string,
  flow: Flow,
  validation: ValidationResult,
): string {
  const warnings = validation.issues
    .filter(i => i.severity === 'warning')
    .map(i => `${FLOW_GLYPHS.info} warning: ${i.message}`);
  return [
    `${FLOW_GLYPHS.success} Saved flow "${name}" to ${file}.`,
    `${FLOW_GLYPHS.info} ${flowSummaryLine(flow)}`,
    ...warnings,
    commitGuidance(name),
  ].join('\n');
}

/** `op=validate` result: one success/error headline plus per-issue rows. */
export function validateResult(name: string, result: ValidationResult): string {
  const head = result.valid
    ? `${FLOW_GLYPHS.success} Validation of "${name}": valid`
    : `${FLOW_GLYPHS.error} Validation of "${name}": INVALID`;
  const lines = result.issues.map(
    i =>
      `${i.severity === 'error' ? FLOW_GLYPHS.error : FLOW_GLYPHS.info} ` +
      `[${i.severity}] ${i.message}`,
  );
  return [
    head,
    ...(lines.length ? lines : [`${FLOW_GLYPHS.success} No issues.`]),
  ].join('\n');
}

/**
 * `op=exec` result: a per-step ledger with a status glyph on every step, so
 * the host colours each line by outcome (green passed / red failed / grey the
 * steps that never ran after a failure) and the human sees the journey replay
 * step by step at a glance.
 */
export function execResult(name: string, result: ExecutionResult): string {
  const stepLines = result.steps.map(stepLedgerLine);
  const headGlyph =
    result.status === 'failed' ? FLOW_GLYPHS.error : FLOW_GLYPHS.success;
  const footer =
    result.status === 'failed'
      ? `${FLOW_GLYPHS.error} Step "${result.steps[result.failedStepIndex]?.name}" failed. ` +
        'Use the browser tools to inspect and fix, then update the flow with ' +
        'op=save or by editing the .cdp.ts file.'
      : `${FLOW_GLYPHS.success} All steps passed.`;
  return [
    `${headGlyph} Replay of "${name}": ${result.status}`,
    ...stepLines,
    footer,
  ].join('\n');
}

/**
 * One ledger line for a replayed step, glyph chosen by outcome (SSoT mapping
 * of step status -> glyph): passed ✓, failed ✗, skipped ⊘ (a step that never
 * ran because an earlier one failed). The host tints the line by that glyph.
 */
function stepLedgerLine(step: StepResult): string {
  switch (step.status) {
    case 'passed':
      return `${FLOW_GLYPHS.success} ${step.name}: passed (${step.actionsRun} action(s))`;
    case 'failed':
      return `${FLOW_GLYPHS.error} ${step.name}: FAILED at ${step.failedAction} — ${step.error}`;
    case 'skipped':
      return `${FLOW_GLYPHS.skipped} ${step.name}: skipped (an earlier step failed)`;
  }
}
