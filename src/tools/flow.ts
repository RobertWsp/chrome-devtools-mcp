/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

/**
 * The `flow` tool is registered behind the --experimental-flows flag and its
 * behavior is wired in main.ts (it needs the process-wide FlowService and the
 * active session). This definition is the single source of truth for its
 * schema and description; the handler is replaced at registration time.
 */
const notWired = async () => {
  throw new Error('flow tool must be wired through FlowService in main.ts.');
};

export const flow = defineTool({
  name: 'flow',
  description: [
    'Record, list, inspect, validate and replay reusable browser flows.',
    'Flows are saved as reviewable .cdp.ts files under .cdpflows/ and can be',
    'replayed to reproduce multi-step journeys (e.g. login) without re-deriving',
    'each tool call, saving tokens. Before building a new journey, call op=list',
    'to reuse an existing flow. Secrets are auto-extracted to .env.',
  ].join(' '),
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
    conditions: ['experimentalFlows'],
  },
  schema: {
    op: zod
      .enum(['list', 'show', 'validate', 'exec', 'save', 'draft'])
      .describe(
        'list: summaries of saved flows. show: source of one flow. ' +
          'validate: run the embedded harness on a saved flow. ' +
          'exec: replay a flow against the session. ' +
          'draft: read the current recording buffer as JSON to restructure ' +
          'into semantic steps. ' +
          'save: persist the current recording as a named flow (optionally ' +
          'with a semantic steps decomposition).',
      ),
    name: zod
      .string()
      .optional()
      .describe('Flow name (required for show, validate, exec, save).'),
    description: zod
      .string()
      .optional()
      .describe('Human-readable description (op=save).'),
    stopAtStep: zod
      .string()
      .optional()
      .describe('For op=exec: replay only up to and including this step.'),
    steps: zod
      .string()
      .optional()
      .describe(
        'For op=save: optional JSON array of semantic steps ' +
          '([{name, description?, actions:[{tool, params}]}]) to store instead ' +
          'of the raw single-step recording. Use op=draft to get the raw ' +
          'actions, then regroup them into named steps.',
      ),
  },
  handler: notWired,
});
