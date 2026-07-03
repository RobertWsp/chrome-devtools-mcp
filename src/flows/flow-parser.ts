/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import ts from 'typescript';

import type {Flow, FlowAction, FlowStep} from './flow-model.js';
import {envRef, parseFlow} from './flow-model.js';

/**
 * Recovers a {@link Flow} AST from a `.cdp.ts` source produced by
 * {@link generateFlowSource}. Rather than executing the module (which would be
 * unsafe and heavy), it statically walks the TypeScript AST for the well-known
 * shape: `defineFlow({ name, description, env, steps: async ctx => { ctx.step(
 * name, () => { ctx.run(tool, params) }) } })`.
 *
 * Throwing here is intentional: an unparseable flow must never be silently
 * treated as empty. The validator surfaces the message to the model.
 */
export function parseFlowSource(source: string): Flow {
  const sf = ts.createSourceFile(
    'flow.cdp.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  const call = findDefineFlowCall(sf);
  if (!call) {
    throw new Error('No defineFlow(...) call found in flow source.');
  }
  const config = call.arguments[0];
  if (!config || !ts.isObjectLiteralExpression(config)) {
    throw new Error('defineFlow must be called with an object literal.');
  }

  const raw: Record<string, unknown> = {
    steps: [],
  };

  for (const prop of config.properties) {
    if (!ts.isPropertyAssignment(prop) || !prop.name) {
      continue;
    }
    const key = propName(prop.name);
    switch (key) {
      case 'name':
      case 'description':
        raw[key] = literal(prop.initializer);
        break;
      case 'createdAt':
      case 'updatedAt':
        raw[key] = literal(prop.initializer);
        break;
      case 'env':
        raw.env = arrayOfStrings(prop.initializer);
        break;
      case 'steps':
        raw.steps = parseSteps(prop.initializer);
        break;
      default:
        break;
    }
  }

  return parseFlow(raw);
}

function findDefineFlowCall(sf: ts.SourceFile): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'defineFlow'
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function parseSteps(initializer: ts.Node): FlowStep[] {
  const body = arrowBody(initializer);
  if (!body) {
    return [];
  }
  const steps: FlowStep[] = [];
  const visit = (node: ts.Node): void => {
    if (isMethodCall(node, 'step')) {
      steps.push(parseStep(node));
      // Do not descend into the step body here; parseStep handles it.
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return steps;
}

function parseStep(call: ts.CallExpression): FlowStep {
  const [nameArg, secondArg, thirdArg] = call.arguments;
  const name = literalString(nameArg);
  let description: string | undefined;
  let cb: ts.Node | undefined;
  if (secondArg && isStringLike(secondArg)) {
    description = literalString(secondArg);
    cb = thirdArg;
  } else {
    cb = secondArg;
  }

  const actions: FlowAction[] = [];
  const body = cb ? arrowBody(cb) : undefined;
  if (body) {
    const visit = (node: ts.Node): void => {
      if (isMethodCall(node, 'run')) {
        actions.push(parseAction(node));
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  }

  return description ? {name, description, actions} : {name, actions};
}

function parseAction(call: ts.CallExpression): FlowAction {
  const [toolArg, paramsArg] = call.arguments;
  const tool = literalString(toolArg);
  const params = paramsArg ? objectValue(paramsArg) : {};
  return {tool, params: params as FlowAction['params']};
}

// --- literal helpers -------------------------------------------------------

function propName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return '';
}

function isMethodCall(
  node: ts.Node,
  method: string,
): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === method
  );
}

function isStringLike(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function literalString(node: ts.Node | undefined): string {
  const value = node ? literal(node) : undefined;
  if (typeof value !== 'string') {
    throw new Error('Expected a string literal in flow source.');
  }
  return value;
}

function literal(node: ts.Node): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const n = Number(node.operand.text);
    return node.operator === ts.SyntaxKind.MinusToken ? -n : n;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(el => value(el));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return objectValue(node);
  }
  throw new Error(
    `Unsupported literal in flow source: ${ts.SyntaxKind[node.kind]}`,
  );
}

/** Resolves a value node, including the special `env("VAR")` call. */
function value(node: ts.Node): unknown {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'env'
  ) {
    return envRef(literalString(node.arguments[0]));
  }
  return literal(node);
}

function objectValue(node: ts.Node): Record<string, unknown> {
  if (!ts.isObjectLiteralExpression(node)) {
    throw new Error('Expected an object literal in flow source.');
  }
  const out: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !prop.name) {
      continue;
    }
    out[propName(prop.name)] = value(prop.initializer);
  }
  return out;
}

function arrayOfStrings(node: ts.Node): string[] {
  if (!ts.isArrayLiteralExpression(node)) {
    return [];
  }
  return node.elements.map(el => literalString(el));
}

/** Returns the body node of an arrow/function expression, if present. */
function arrowBody(node: ts.Node): ts.Node | undefined {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node.body;
  }
  return undefined;
}
