import test from 'node:test';
import assert from 'node:assert/strict';
import { captureReviewedExecutionRequest } from './reviewedExecution.js';

test('ADR-040 A40-2 captures a detached, deeply frozen reviewed execution request', () => {
  const request = {
    prompt: 'Run the reviewed build.',
    toolName: 'run_workflow' as const,
    args: {
      template: 'build',
      templateArgs: {
        task: 'Implement the reviewed change.',
        files: [{ path: 'src/index.ts', required: true }],
      },
    },
    requestId: 'reviewed-request-1',
  };

  const captured = captureReviewedExecutionRequest(request);
  request.prompt = 'Mutated prompt';
  request.args.templateArgs.task = 'Mutated task';
  request.args.templateArgs.files[0]!.path = 'other.ts';

  assert.deepEqual(captured, {
    prompt: 'Run the reviewed build.',
    toolName: 'run_workflow',
    args: {
      template: 'build',
      templateArgs: {
        task: 'Implement the reviewed change.',
        files: [{ path: 'src/index.ts', required: true }],
      },
    },
    requestId: 'reviewed-request-1',
  });
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.args), true);
  const templateArgs = captured.args.templateArgs as Readonly<Record<string, unknown>>;
  assert.equal(Object.isFrozen(templateArgs), true);
  const files = templateArgs.files as readonly Readonly<Record<string, unknown>>[];
  assert.equal(Object.isFrozen(files), true);
  assert.equal(Object.isFrozen(files[0]), true);
});

test('ADR-040 A40-2 shares one cumulative string budget across prompt, requestId, and args', () => {
  assert.throws(() => captureReviewedExecutionRequest({
    prompt: 'p'.repeat(250_000),
    toolName: 'run_workflow',
    args: {
      a: 'a'.repeat(249_990),
      b: 'b'.repeat(249_990),
      c: 'c'.repeat(249_990),
    },
    requestId: 'r'.repeat(128),
  }), /cumulative string-size limit/);
});

test('ADR-040 A40-2 rejects aggregate object-key characters over the reviewed request budget', () => {
  const args = Object.create(null) as Record<string, null>;
  for (let index = 0; index < 4; index += 1) {
    args[`${'k'.repeat(250_000)}${index}`] = null;
  }

  assert.throws(() => captureReviewedExecutionRequest({
    prompt: '',
    toolName: 'run_workflow_graph',
    args,
  }), /cumulative string-size limit/);
});

test('ADR-040 A40-2 rejects unsafe and newline-bearing reviewed request IDs', () => {
  for (const requestId of ['unsafe request id', 'unsafe\nrequest-id']) {
    assert.throws(() => captureReviewedExecutionRequest({
      prompt: 'Run it.',
      toolName: 'run_workflow',
      args: { template: 'build', templateArgs: { task: 'Reviewed task' } },
      requestId,
    }), /opaque ID of at most 128 safe characters/);
  }
});
