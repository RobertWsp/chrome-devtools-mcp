/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  isElementTarget,
  resolveTargetUid,
  type TargetNode,
  targetFromAXNode,
} from '../../src/flows/element-target.js';

function node(
  id: string,
  role: string,
  name?: string,
  value?: string,
): TargetNode {
  return {id, role, name, value};
}

describe('element-target', () => {
  describe('targetFromAXNode', () => {
    it('extracts role + name + value', () => {
      const t = targetFromAXNode({role: 'textbox', name: 'Email', value: 'x'});
      assert.deepStrictEqual(t, {role: 'textbox', name: 'Email', value: 'x'});
    });

    it('normalizes whitespace in the name', () => {
      const t = targetFromAXNode({role: 'button', name: '  Sign   in \n'});
      assert.strictEqual(t?.name, 'Sign in');
    });

    it('returns undefined for a nameless generic node (too ambiguous)', () => {
      assert.strictEqual(targetFromAXNode({role: 'generic'}), undefined);
      assert.strictEqual(targetFromAXNode(undefined), undefined);
    });

    it('keeps a nameless node when its role is specific', () => {
      const t = targetFromAXNode({role: 'checkbox'});
      assert.deepStrictEqual(t, {role: 'checkbox'});
    });
  });

  describe('resolveTargetUid (tiered, fail-safe)', () => {
    const snapshot = [
      node('9_1', 'textbox', 'Email'),
      node('9_2', 'textbox', 'Password'),
      node('9_3', 'button', 'Sign in'),
      node('9_4', 'link', 'Forgot password?'),
    ];

    it('tier 1: exact role + name -> fresh uid', () => {
      assert.strictEqual(
        resolveTargetUid({role: 'button', name: 'Sign in'}, snapshot),
        '9_3',
      );
    });

    it('tier 2: exact name, role changed -> still resolves if unique', () => {
      assert.strictEqual(
        resolveTargetUid({role: 'menuitem', name: 'Sign in'}, snapshot),
        '9_3',
      );
    });

    it('tier 3: role + partial name (dynamic suffix)', () => {
      const withBadge = [...snapshot, node('9_5', 'button', 'Cart (3)')];
      assert.strictEqual(
        resolveTargetUid({role: 'button', name: 'Cart'}, withBadge),
        '9_5',
      );
    });

    it('disambiguates identical labels by value', () => {
      const dup = [
        node('9_1', 'textbox', 'Item', 'apple'),
        node('9_2', 'textbox', 'Item', 'banana'),
      ];
      assert.strictEqual(
        resolveTargetUid({role: 'textbox', name: 'Item', value: 'banana'}, dup),
        '9_2',
      );
    });

    it('refuses to guess when several identical elements remain (no value)', () => {
      const dup = [
        node('9_1', 'textbox', 'Item'),
        node('9_2', 'textbox', 'Item'),
      ];
      assert.strictEqual(
        resolveTargetUid({role: 'textbox', name: 'Item'}, dup),
        undefined,
      );
    });

    it('returns undefined when nothing matches', () => {
      assert.strictEqual(
        resolveTargetUid({role: 'button', name: 'Nonexistent'}, snapshot),
        undefined,
      );
    });

    it('nameless target resolves only when the role is unique', () => {
      assert.strictEqual(resolveTargetUid({role: 'link'}, snapshot), '9_4');
      assert.strictEqual(
        resolveTargetUid({role: 'textbox'}, snapshot),
        undefined, // two textboxes -> ambiguous
      );
    });
  });

  it('isElementTarget type guard', () => {
    assert.ok(isElementTarget({role: 'button'}));
    assert.ok(!isElementTarget({name: 'x'}));
    assert.ok(!isElementTarget(null));
    assert.ok(!isElementTarget('button'));
  });
});
