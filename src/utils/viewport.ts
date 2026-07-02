/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Single source of truth for parsing a `"<width>x<height>"` viewport string
 * (e.g. `"1280x720"`). Returns `undefined` for empty input and throws for a
 * malformed value so callers can decide how strict to be.
 */
export function parseViewport(
  value: string | undefined,
): ViewportSize | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const [width, height] = value.split('x').map(Number);
  if (!width || !height || Number.isNaN(width) || Number.isNaN(height)) {
    throw new Error('Invalid viewport. Expected format is `1280x720`.');
  }
  return {width, height};
}
