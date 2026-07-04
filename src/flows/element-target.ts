/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SerializedAXNode} from 'puppeteer-core';

/**
 * A DURABLE descriptor of a page element, derived from its accessibility node.
 *
 * ## Why this exists
 *
 * The live snapshot addresses elements by an EPHEMERAL `uid`
 * (`<snapshotId>_<counter>`): the id namespace changes on every new snapshot,
 * so a `uid` captured while recording (e.g. `1_5`) is meaningless on replay
 * against a fresh snapshot (`12_5`), and `getElementByUid` throws "No such
 * element found in the snapshot". That made EVERY recorded uid-based action
 * fail on replay.
 *
 * An {@link ElementTarget} is stable across runs because it is the element's
 * SEMANTIC identity (its ARIA role + accessible name, plus a value hint),
 * exactly what a human reads. The recorder stores it alongside the uid; the
 * executor re-resolves it to a FRESH uid in the current snapshot before acting.
 * This makes replay resilient to a new id namespace, element re-ordering, and
 * small structural changes, and avoids clicking the wrong element.
 */
export interface ElementTarget {
  /** ARIA role (e.g. `button`, `textbox`). Primary filter. */
  role: string;
  /** Accessible name (label/text). The main discriminator. */
  name?: string;
  /** Value hint for inputs (helps disambiguate identical labels). */
  value?: string;
}

/** Marker key under which a resolved target is stored on a recorded param. */
export const TARGET_PARAM = '__target';

/** Minimal shape the resolver needs from a snapshot node. */
export interface TargetNode {
  id: string;
  role: string;
  name?: string;
  value?: string | number;
}

/**
 * Extracts a durable {@link ElementTarget} from an accessibility node, or
 * undefined when the node has no usable identity (no name AND a generic role),
 * in which case the caller keeps the raw uid as the only handle.
 */
export function targetFromAXNode(
  node: Pick<SerializedAXNode, 'role' | 'name' | 'value'> | undefined,
): ElementTarget | undefined {
  if (!node) {
    return undefined;
  }
  const name = normalizeName(node.name);
  // Without a name, a bare role is too ambiguous to re-resolve safely.
  if (!name && (!node.role || node.role === 'generic')) {
    return undefined;
  }
  const target: ElementTarget = {role: node.role};
  if (name) {
    target.name = name;
  }
  if (typeof node.value === 'string' && node.value.trim()) {
    target.value = node.value.trim();
  }
  return target;
}

/** Type guard for an {@link ElementTarget} parsed from stored params. */
export function isElementTarget(value: unknown): value is ElementTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ElementTarget).role === 'string'
  );
}

/**
 * Re-resolves a durable target to a CONCRETE snapshot uid, using a tiered
 * strategy so a small change on the page doesn't break replay (Strategy /
 * chain of responsibility):
 *
 *   1. exact role + exact (normalized) name  -- the common, unambiguous case
 *   2. exact name only (role changed)        -- structure changed, label same
 *   3. role + name startsWith/contains       -- dynamic suffixes/counts
 *
 * Returns the fresh uid, or undefined when no candidate matches (the caller
 * then fails the step with a clear message rather than acting on the wrong
 * element).
 */
export function resolveTargetUid(
  target: ElementTarget,
  nodes: Iterable<TargetNode>,
): string | undefined {
  const wantName = normalizeName(target.name);
  const all = [...nodes];

  // Tier 1: role + exact name.
  if (wantName) {
    const exact = all.filter(
      n => n.role === target.role && normalizeName(n.name) === wantName,
    );
    const picked = disambiguate(exact, target);
    if (picked) {
      return picked.id;
    }

    // Tier 2: exact name, any role (the element's role changed).
    const byName = all.filter(n => normalizeName(n.name) === wantName);
    if (byName.length === 1) {
      return byName[0].id;
    }

    // Tier 3: role + partial name (dynamic suffix like a count badge).
    const partial = all.filter(
      n =>
        n.role === target.role && partialMatch(normalizeName(n.name), wantName),
    );
    const pickedPartial = disambiguate(partial, target);
    if (pickedPartial) {
      return pickedPartial.id;
    }
    return undefined;
  }

  // No name: only safe when the role is unique on the page.
  const byRole = all.filter(n => n.role === target.role);
  return byRole.length === 1 ? byRole[0].id : undefined;
}

/** Among equal-name candidates, prefer one whose value also matches. */
function disambiguate(
  candidates: TargetNode[],
  target: ElementTarget,
): TargetNode | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (target.value) {
    const byValue = candidates.filter(
      n => n.value !== undefined && String(n.value).trim() === target.value,
    );
    if (byValue.length === 1) {
      return byValue[0];
    }
  }
  // Ambiguous (several identical elements) -> refuse rather than guess wrong.
  return undefined;
}

function partialMatch(candidate: string, want: string): boolean {
  if (!candidate || !want) {
    return false;
  }
  return candidate.startsWith(want) || candidate.includes(want);
}

/** Collapses whitespace and trims so cosmetic label changes don't break match. */
function normalizeName(name: string | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim();
}
