/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Context} from '../tools/ToolDefinition.js';

import {parseFlowSteps} from './flow-model.js';
import type {FlowService} from './FlowService.js';

export interface FlowOpParams {
  op: string;
  name?: string;
  description?: string;
  stopAtStep?: string;
  sessionId?: string;
  steps?: string;
  /** Transport-level owner id (isolation); not a model-facing param. */
  owner?: string;
}

/**
 * Runs a browser tool action against a session under its mutex. Injected so
 * the controller stays decoupled from SessionManager (the transport layer
 * owns session resolution + locking). The `owner` scopes access so a flow can
 * only replay against a session the caller owns.
 */
export type SessionRunner = <T>(
  sessionId: string,
  owner: string | undefined,
  run: (context: Context) => Promise<T>,
) => Promise<T>;

/**
 * Renders the op-based `flow` tool. It returns the response body (without the
 * `# flow response` header, which the transport adds) or throws a readable
 * Error. Keeping all op logic here mirrors the SessionService facade and keeps
 * main.ts a thin adapter; the controller is unit-testable without the MCP
 * server.
 */
export class FlowController {
  readonly #service: FlowService;
  readonly #runInSession: SessionRunner;

  constructor(service: FlowService, runInSession: SessionRunner) {
    this.#service = service;
    this.#runInSession = runInSession;
  }

  async handle(params: FlowOpParams): Promise<string> {
    switch (params.op) {
      case 'list':
        return this.#list(params.sessionId);
      case 'show':
        return this.#show(this.#requireName(params), params.sessionId);
      case 'validate':
        return this.#validate(this.#requireName(params), params.sessionId);
      case 'draft':
        return this.#draft(this.#requireSession(params));
      case 'save':
        return this.#save(params);
      case 'exec':
        return this.#exec(params);
      default:
        throw new Error(`Unknown flow op "${params.op}".`);
    }
  }

  #requireName(params: FlowOpParams): string {
    if (!params.name) {
      throw new Error(`op=${params.op} requires a flow name.`);
    }
    return params.name;
  }

  #requireSession(params: FlowOpParams): string {
    if (!params.sessionId) {
      throw new Error(`op=${params.op} requires a sessionId.`);
    }
    return params.sessionId;
  }

  async #list(sessionId?: string): Promise<string> {
    const flows = await this.#service.list(sessionId);
    if (flows.length === 0) {
      return 'No saved flows yet. Actions are being recorded; use op=save to persist one.';
    }
    const lines = flows.map(
      f =>
        `- **${f.name}** — ${f.description || 'no description'} (${f.steps} step(s), ${f.actions} action(s)${f.env.length ? `, env: ${f.env.join(', ')}` : ''})`,
    );
    return `Saved flows:\n${lines.join('\n')}`;
  }

  async #show(name: string, sessionId?: string): Promise<string> {
    const source = await this.#service.readSource(name, sessionId);
    return `Source of "${name}":\n\n\`\`\`ts\n${source}\n\`\`\``;
  }

  async #validate(name: string, sessionId?: string): Promise<string> {
    const result = await this.#service.validateStored(name, sessionId);
    const lines = result.issues.map(i => `- [${i.severity}] ${i.message}`);
    return `Validation of "${name}": ${result.valid ? 'valid' : 'INVALID'}\n${
      lines.join('\n') || 'No issues.'
    }`;
  }

  #draft(sessionId: string): string {
    const draft = this.#service.draftRecording(sessionId);
    const actions = draft.steps[0]?.actions ?? [];
    return [
      `Recording buffer for session ${sessionId}: ${actions.length} action(s).`,
      'Regroup these into semantic steps and pass them to op=save as JSON:',
      '```json',
      JSON.stringify(actions, null, 2),
      '```',
    ].join('\n');
  }

  async #save(params: FlowOpParams): Promise<string> {
    const name = this.#requireName(params);
    const sessionId = this.#requireSession(params);
    let steps;
    if (params.steps) {
      try {
        steps = parseFlowSteps(params.steps);
      } catch (err) {
        throw new Error(
          `Invalid steps JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const {file, flow, validation} = await this.#service.saveRecording(
      sessionId,
      name,
      params.description ?? '',
      steps,
    );
    const warnings = validation.issues
      .filter(i => i.severity === 'warning')
      .map(i => `- ${i.message}`);
    return [
      `Saved flow "${name}" to ${file}.`,
      this.#service.summarize(flow),
      warnings.length ? `Warnings:\n${warnings.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async #exec(params: FlowOpParams): Promise<string> {
    const name = this.#requireName(params);
    const sessionId = this.#requireSession(params);
    return this.#runInSession(sessionId, params.owner, async context => {
      const result = await this.#service.exec(name, context, {
        stopAtStep: params.stopAtStep,
        sessionId,
      });
      const stepLines = result.steps.map(s =>
        s.status === 'passed'
          ? `- ${s.name}: passed (${s.actionsRun} action(s))`
          : `- ${s.name}: FAILED at ${s.failedAction} — ${s.error}`,
      );
      const footer =
        result.status === 'failed'
          ? `\nStep "${result.steps[result.failedStepIndex]?.name}" failed. Use the browser tools to inspect and fix, then update the flow with op=save or by editing the .cdp.ts file.`
          : '\nAll steps passed.';
      return `Replay of "${name}": ${result.status}\n${stepLines.join('\n')}${footer}`;
    });
  }
}
