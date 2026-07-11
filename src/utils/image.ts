/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for the limits that decide whether a screenshot can
 * be inlined into an MCP response or must be spilled to a temporary file.
 *
 * The byte cap keeps individual responses small. The edge cap mirrors the
 * hard limit enforced by downstream vision APIs (Anthropic rejects any image
 * whose longest edge exceeds 8000px with "Could not process image"), which is
 * easy to trip on HiDPI displays where `deviceScaleFactor` doubles the pixel
 * dimensions of a full-page screenshot even when the encoded bytes stay small.
 */
export const MAX_INLINE_IMAGE_BYTES = 2_000_000;
export const MAX_INLINE_IMAGE_EDGE = 8000;

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Reads the pixel dimensions of a PNG, JPEG or WebP image from its header
 * bytes without decoding the whole bitmap. Returns `undefined` when the format
 * is unrecognized or the header is truncated.
 */
export function readImageSize(data: Uint8Array): ImageSize | undefined {
  return (
    readPngSize(data) ?? readJpegSize(data) ?? readWebpSize(data) ?? undefined
  );
}

/**
 * Decides whether an encoded screenshot is safe to inline in the response.
 * Over-large images (by bytes or by any edge) must be written to a file so the
 * downstream vision API does not reject the whole response.
 */
export function canInlineImage(data: Uint8Array): boolean {
  if (data.length >= MAX_INLINE_IMAGE_BYTES) {
    return false;
  }
  const size = readImageSize(data);
  if (
    size &&
    (size.width > MAX_INLINE_IMAGE_EDGE || size.height > MAX_INLINE_IMAGE_EDGE)
  ) {
    return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPngSize(data: Uint8Array): ImageSize | undefined {
  if (data.length < 24) {
    return undefined;
  }
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (data[i] !== PNG_MAGIC[i]) {
      return undefined;
    }
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // IHDR width/height are the two big-endian uint32 at offset 16.
  return {width: view.getUint32(16), height: view.getUint32(20)};
}

function readJpegSize(data: Uint8Array): ImageSize | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1];
    // SOF markers carry the frame dimensions (skip C4/C8/CC which are not SOF).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    }
    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2) {
      return undefined;
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function readWebpSize(data: Uint8Array): ImageSize | undefined {
  if (
    data.length < 30 ||
    data[0] !== 0x52 || // R
    data[1] !== 0x49 || // I
    data[2] !== 0x46 || // F
    data[3] !== 0x46 || // F
    data[8] !== 0x57 || // W
    data[9] !== 0x45 || // E
    data[10] !== 0x42 || // B
    data[11] !== 0x50 // P
  ) {
    return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const format = String.fromCharCode(data[12], data[13], data[14], data[15]);
  if (format === 'VP8 ') {
    // Lossy: 14-bit width/height at offset 26, minus one convention removed.
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return {width, height};
  }
  if (format === 'VP8L') {
    // Lossless: 14-bit width/height packed after the 0x2f signature byte.
    const bits =
      data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return {width, height};
  }
  if (format === 'VP8X') {
    // Extended: 24-bit width/height minus one at offset 24.
    const width = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1;
    const height = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1;
    return {width, height};
  }
  return undefined;
}
