/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {extractOwner, OWNER_PARAM} from '../src/owner.js';

describe('extractOwner', () => {
  it('returns undefined owner and unchanged params when absent', () => {
    const params = {sessionId: 's', url: 'x'};
    const {owner, rest} = extractOwner(params);
    assert.strictEqual(owner, undefined);
    assert.deepStrictEqual(rest, params);
  });

  it('extracts the owner and strips the reserved key', () => {
    const {owner, rest} = extractOwner({
      [OWNER_PARAM]: 'client-123',
      sessionId: 's',
      url: 'x',
    });
    assert.strictEqual(owner, 'client-123');
    assert.deepStrictEqual(rest, {sessionId: 's', url: 'x'});
    assert.ok(!(OWNER_PARAM in rest), 'reserved key must be stripped');
  });

  it('treats an empty or non-string owner as undefined', () => {
    assert.strictEqual(extractOwner({[OWNER_PARAM]: ''}).owner, undefined);
    assert.strictEqual(extractOwner({[OWNER_PARAM]: 42}).owner, undefined);
    // Still strips the key.
    assert.ok(!(OWNER_PARAM in extractOwner({[OWNER_PARAM]: 42}).rest));
  });
});
