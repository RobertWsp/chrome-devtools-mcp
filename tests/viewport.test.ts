/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {parseViewport} from '../src/utils/viewport.js';

describe('parseViewport', () => {
  it('returns undefined for undefined or empty', () => {
    assert.strictEqual(parseViewport(undefined), undefined);
    assert.strictEqual(parseViewport(''), undefined);
  });

  it('parses a valid WxH string', () => {
    assert.deepStrictEqual(parseViewport('1280x720'), {
      width: 1280,
      height: 720,
    });
  });

  it('throws on malformed input', () => {
    for (const bad of ['1280', '1280x', 'x720', 'axb', '0x100', '100x0']) {
      assert.throws(() => parseViewport(bad), /Invalid viewport/, bad);
    }
  });
});
