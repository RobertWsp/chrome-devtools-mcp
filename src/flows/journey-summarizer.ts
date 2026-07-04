/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isElementTarget, TARGET_PARAM} from './element-target.js';
import type {Flow, FlowAction, FlowStep} from './flow-model.js';
import {hostOf, isNavigation, slugify} from './journey-actions.js';

/**
 * Turns a flat recorded journey into a STRUCTURED draft flow with a general
 * description and one short description per step -- deterministically, from the
 * action stream itself (no LLM call at auto-save time).
 *
 * ## Why segment here
 *
 * The recorder produces one flat action list. A useful reusable flow reads as
 * a few named phases (open -> login -> ...). We segment at NAVIGATION
 * boundaries (each `navigate_page`/`new_page` starts a new phase, the natural
 * unit of a browser journey) and derive a human label + one-line description
 * for each phase from its actions' element targets (role + accessible name),
 * which the recorder now captures. The model can still rename/refine via
 * op=save; this only makes the AUTO draft self-describing instead of an opaque
 * single "journey" block.
 *
 * Pure + deterministic: same input -> same output, trivially testable.
 */

/** Builds the structured steps for a recorded journey. */
export function summarizeJourney(actions: readonly FlowAction[]): FlowStep[] {
  const segments = segmentByNavigation(actions);
  return segments.map((segment, i) => {
    const name = stepName(segment, i);
    const description = stepDescription(segment);
    const step: FlowStep = {name, actions: segment.slice()};
    if (description) {
      step.description = description;
    }
    return step;
  });
}

/**
 * Builds a whole draft {@link Flow} for an auto-saved journey: structured
 * steps + a general description summarizing the phases and the entry origin.
 */
export function buildAutoDraft(
  name: string,
  actions: readonly FlowAction[],
): Flow {
  const steps = summarizeJourney(actions);
  return {
    name,
    description: flowDescription(steps, actions),
    env: [],
    steps:
      steps.length > 0 ? steps : [{name: 'journey', actions: actions.slice()}],
  };
}

/** Splits actions into contiguous segments, each starting at a navigation. */
function segmentByNavigation(actions: readonly FlowAction[]): FlowAction[][] {
  const segments: FlowAction[][] = [];
  for (const action of actions) {
    if (isNavigation(action) || segments.length === 0) {
      segments.push([action]);
    } else {
      segments[segments.length - 1].push(action);
    }
  }
  return segments;
}

/** A short, file-safe step label derived from the segment's shape. */
function stepName(segment: FlowAction[], index: number): string {
  const first = segment[0];
  if (first && isNavigation(first)) {
    const host = hostOf(first);
    return host
      ? slugify(`open-${host}`)
      : index === 0
        ? 'open'
        : `open-${index + 1}`;
  }
  // Non-nav segment: name after the dominant interaction verb.
  const verb = dominantVerb(segment);
  return slugify(verb) || `step-${index + 1}`;
}

/** One-line human description of what the step does. */
function stepDescription(segment: FlowAction[]): string {
  const parts = segment.map(describeAction).filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  // Keep it short: first two distinct phrases.
  const distinct = [...new Set(parts)];
  return capitalize(distinct.slice(0, 2).join(', '));
}

/** A general description of the whole flow from its phases. */
function flowDescription(
  steps: FlowStep[],
  actions: readonly FlowAction[],
): string {
  const entry = actions.find(isNavigation);
  const host = entry ? hostOf(entry) : undefined;
  const phases = steps.map(s => s.name).join(' -> ');
  const where = host ? ` on ${host}` : '';
  return (
    `Auto-recorded browser journey${where}: ${phases}. ` +
    `Review, rename and refine with flow op=save.`
  );
}

/** Describes a single action in a few words using its element target. */
function describeAction(action: FlowAction): string {
  if (isNavigation(action)) {
    const host = hostOf(action);
    return host ? `go to ${host}` : 'navigate';
  }
  const label = targetLabel(action);
  switch (action.tool) {
    case 'click':
    case 'click_at':
      return label ? `click ${label}` : 'click';
    case 'fill':
      return label ? `fill ${label}` : 'fill a field';
    case 'fill_form':
      return 'fill the form';
    case 'hover':
      return label ? `hover ${label}` : 'hover';
    case 'press_key':
      return `press ${String(action.params.key ?? 'a key')}`;
    case 'upload_file':
      return 'upload a file';
    case 'select':
      return label ? `select ${label}` : 'select an option';
    default:
      return action.tool.replace(/_/g, ' ');
  }
}

/** The most representative interaction verb of a non-nav segment. */
function dominantVerb(segment: FlowAction[]): string {
  const hasFill = segment.some(
    a => a.tool === 'fill' || a.tool === 'fill_form',
  );
  const hasClick = segment.some(
    a => a.tool === 'click' || a.tool === 'click_at',
  );
  if (hasFill && hasClick) {
    return 'fill-and-submit';
  }
  if (hasFill) {
    return 'fill';
  }
  if (hasClick) {
    return 'interact';
  }
  return segment[0]?.tool.replace(/_/g, '-') ?? 'step';
}

/** Reads the accessible name of the action's element target, if any. */
function targetLabel(action: FlowAction): string | undefined {
  const target = action.params[TARGET_PARAM];
  if (isElementTarget(target) && target.name) {
    return `"${target.name}"`;
  }
  return undefined;
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
