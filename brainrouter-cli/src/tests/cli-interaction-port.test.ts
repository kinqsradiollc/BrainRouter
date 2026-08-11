/**
 * ADR-034 production CLI approval-adapter regression. It drives the real
 * readline/TTY seam and pins that only literal y/n are terminal; headless and
 * empty/cancel-equivalent input remain dismissed so durable holds survive.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cliInteractionPort } from '../cli/prompt/cliInteractionPort.js';
import { setActiveReadline } from '../cli/prompt/cliPrompt.js';

test('production CLI session-message confirmation distinguishes approved, declined, and dismissed', async (t) => {
  const originalTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const answers: string[] = [];
  const fakeReadline = {
    resume: () => undefined,
    pause: () => undefined,
    question: (_question: string, callback: (answer: string) => void) => {
      callback(answers.shift() ?? '');
    },
  };
  t.after(() => {
    setActiveReadline(undefined);
    if (originalTty) Object.defineProperty(process.stdin, 'isTTY', originalTty);
    else delete (process.stdin as unknown as Record<string, unknown>).isTTY;
  });
  setActiveReadline(fakeReadline as any);

  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  assert.equal(await cliInteractionPort.confirmExplicit?.({ title: 'Peer message' }), 'dismissed');

  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  answers.push('');
  assert.equal(await cliInteractionPort.confirmExplicit?.({ title: 'Peer message' }), 'dismissed');
  answers.push('n');
  assert.equal(await cliInteractionPort.confirmExplicit?.({ title: 'Peer message' }), 'declined');
  answers.push('y');
  assert.equal(await cliInteractionPort.confirmExplicit?.({ title: 'Peer message' }), 'approved');
});
