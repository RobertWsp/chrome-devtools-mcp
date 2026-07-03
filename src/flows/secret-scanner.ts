/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Flow, FlowAction} from './flow-model.js';
import {envRef, isEnvRef} from './flow-model.js';

/**
 * Param keys whose values are treated as secret by name, regardless of
 * content. Matched case-insensitively as a substring so `password`,
 * `newPassword`, `apiToken`, etc. are all covered.
 */
const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'auth',
  'credential',
  'otp',
  'pin',
  'private',
];

/** Heuristics for secret-looking values even under a non-secret key. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{8,}/,
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI-style keys
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bAKIA[0-9A-Z]{12,}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, // JWT
];

export interface ExtractedSecret {
  /** Environment variable name the value is stored under. */
  envVar: string;
  /** The literal value pulled out of the action params. */
  value: string;
}

export interface SecretScanResult {
  flow: Flow;
  secrets: ExtractedSecret[];
}

function keyLooksSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some(pattern => lower.includes(pattern));
}

function valueLooksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Derives a stable, unique env var name for a secret found under `key` within
 * `flowName`, e.g. `login` + `password` -> `LOGIN_PASSWORD`. Collisions get a
 * numeric suffix.
 */
function deriveEnvVar(
  flowName: string,
  key: string,
  taken: Set<string>,
): string {
  const base = `${flowName}_${key}`
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
  let name = base || 'SECRET';
  let i = 2;
  while (taken.has(name)) {
    name = `${base}_${i++}`;
  }
  taken.add(name);
  return name;
}

/**
 * Scans a flow for secret-looking literal values and replaces them with env
 * references. Values already referencing the environment are left untouched.
 * Returns a new flow plus the extracted secrets so callers can persist them to
 * a gitignored `.env` (single source of truth for secret storage).
 */
export function extractSecrets(flow: Flow): SecretScanResult {
  const secrets: ExtractedSecret[] = [];
  const taken = new Set<string>(flow.env);
  const byValue = new Map<string, string>();

  const scanParams = (params: FlowAction['params']): FlowAction['params'] => {
    const out: FlowAction['params'] = {};
    for (const [key, value] of Object.entries(params)) {
      if (isEnvRef(value)) {
        out[key] = value;
        continue;
      }
      if (
        typeof value === 'string' &&
        value.length > 0 &&
        (keyLooksSecret(key) || valueLooksSecret(value))
      ) {
        // Reuse the same env var for identical repeated values.
        let envVar = byValue.get(value);
        if (!envVar) {
          envVar = deriveEnvVar(flow.name, key, taken);
          byValue.set(value, envVar);
          secrets.push({envVar, value});
        }
        out[key] = envRef(envVar);
        continue;
      }
      out[key] = value;
    }
    return out;
  };

  const steps = flow.steps.map(step => ({
    ...step,
    actions: step.actions.map(action => ({
      ...action,
      params: scanParams(action.params),
    })),
  }));

  const env = [...new Set([...flow.env, ...secrets.map(s => s.envVar)])];
  return {flow: {...flow, steps, env}, secrets};
}

/**
 * Detects secret-looking literals that survived extraction -- used by the
 * validator to block committing a flow that still embeds a raw secret.
 */
export function findLeakedSecrets(flow: Flow): string[] {
  const leaks: string[] = [];
  for (const step of flow.steps) {
    for (const action of step.actions) {
      for (const [key, value] of Object.entries(action.params)) {
        if (
          typeof value === 'string' &&
          (keyLooksSecret(key) || valueLooksSecret(value))
        ) {
          leaks.push(`${step.name} > ${action.tool}.${key}`);
        }
      }
    }
  }
  return leaks;
}
