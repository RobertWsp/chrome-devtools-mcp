/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {textResult, errorResult} from '../src/McpResult.js';

describe('McpResult', () => {
  describe('textResult', () => {
    it('wraps text with no error flag', () => {
      const result = textResult('hello');
      assert.deepStrictEqual(result, {
        content: [{type: 'text', text: 'hello'}],
      });
      assert.strictEqual(result.isError, undefined);
    });
  });

  describe('errorResult', () => {
    it('unwraps an Error message', () => {
      const result = errorResult(new Error('boom'));
      assert.deepStrictEqual(result, {
        content: [{type: 'text', text: 'boom'}],
        isError: true,
      });
    });

    it('appends a nested cause message', () => {
      const err = new Error('outer', {cause: new Error('inner')});
      const result = errorResult(err);
      assert.strictEqual(
        (result.content[0] as {text: string}).text,
        'outer\nCause: inner',
      );
      assert.strictEqual(result.isError, true);
    });

    it('stringifies non-Error values', () => {
      const result = errorResult('plain string');
      assert.strictEqual(
        (result.content[0] as {text: string}).text,
        'plain string',
      );
      assert.strictEqual(result.isError, true);
    });

    it('ignores a non-Error cause', () => {
      const err = new Error('outer', {cause: 'not-an-error'});
      const result = errorResult(err);
      assert.strictEqual((result.content[0] as {text: string}).text, 'outer');
    });
  });
});
