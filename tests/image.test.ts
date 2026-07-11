/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  canInlineImage,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_EDGE,
  readImageSize,
} from '../src/utils/image.js';

function makePng(width: number, height: number, byteLength = 24): Uint8Array {
  const buf = new Uint8Array(Math.max(byteLength, 24));
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(buf.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return buf;
}

function makeJpeg(width: number, height: number): Uint8Array {
  // SOI + SOF0 marker carrying height/width.
  const buf = new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // segment length
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // components
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return buf;
}

describe('readImageSize', () => {
  it('reads PNG dimensions', () => {
    assert.deepStrictEqual(readImageSize(makePng(1905, 20074)), {
      width: 1905,
      height: 20074,
    });
  });

  it('reads JPEG dimensions', () => {
    assert.deepStrictEqual(readImageSize(makeJpeg(640, 480)), {
      width: 640,
      height: 480,
    });
  });

  it('returns undefined for unknown formats', () => {
    assert.strictEqual(readImageSize(new Uint8Array([1, 2, 3, 4])), undefined);
  });
});

describe('canInlineImage', () => {
  it('accepts a small, in-bounds image', () => {
    assert.strictEqual(canInlineImage(makePng(800, 600)), true);
  });

  it('rejects an image taller than the edge limit', () => {
    // The exact HiDPI full-page regression: small bytes, huge height.
    assert.strictEqual(
      canInlineImage(makePng(1905, MAX_INLINE_IMAGE_EDGE + 1)),
      false,
    );
  });

  it('rejects an image wider than the edge limit', () => {
    assert.strictEqual(
      canInlineImage(makePng(MAX_INLINE_IMAGE_EDGE + 1, 600)),
      false,
    );
  });

  it('accepts an image exactly at the edge limit', () => {
    assert.strictEqual(
      canInlineImage(makePng(MAX_INLINE_IMAGE_EDGE, MAX_INLINE_IMAGE_EDGE)),
      true,
    );
  });

  it('rejects an oversized byte payload regardless of dimensions', () => {
    assert.strictEqual(
      canInlineImage(makePng(100, 100, MAX_INLINE_IMAGE_BYTES)),
      false,
    );
  });
});
