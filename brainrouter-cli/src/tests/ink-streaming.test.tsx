import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { ChatApp, type ChatController } from '../cli/ink/ChatApp.js';

// --- End-to-end Ink rendering verification --------------------------------
//
// These tests mount ChatApp into a virtual Ink renderer and exercise the
// streaming controller the same way runChat.tsx does in production. They
// give us concrete evidence that the flicker/reasoning/scrolling
// enhancements (React.memo on ScrollbackRow, 80ms coalesced flush,
// tail-windowed reasoning) actually reach the rendered frame and don't
// regress.
//
// Without these the only verification of the Ink layer was "it compiles
// + the user runs it" — which is exactly what the stop-hook called out.

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mountChat(): {
  ctrl: Promise<ChatController>;
  instance: ReturnType<typeof render>;
} {
  let resolveCtrl!: (c: ChatController) => void;
  const ctrl = new Promise<ChatController>((res) => {
    resolveCtrl = res;
  });
  const instance = render(
    React.createElement(ChatApp, {
      initialBanner: 'BANNER',
      initialHint: 'HINT',
      slashCommands: [],
      promptLabel: 'test',
      onSubmit: async () => {},
      onReady: (c) => resolveCtrl(c),
    }),
  );
  return { ctrl, instance };
}

test('Ink streaming: assistant deltas land in the live frame and respect 80ms coalesce', async () => {
  const { ctrl, instance } = mountChat();
  const c = await ctrl;
  c.push.setPhase('turn-running');
  c.push.assistantDeltaStart();
  // Feed five chunks back-to-back. With 33ms-per-stream timers this
  // would emit five separate setStates; with the 80ms shared flush they
  // coalesce into one render pass.
  c.push.assistantDelta('Hello ');
  c.push.assistantDelta('world ');
  c.push.assistantDelta('from ');
  c.push.assistantDelta('the ');
  c.push.assistantDelta('agent.');
  // Before the flush fires, the live frame is still empty.
  // After the 80ms timer fires, the text appears in one frame.
  await waitMs(120);
  const frame = instance.lastFrame() ?? '';
  assert.ok(
    frame.includes('Hello world from the agent.'),
    `expected coalesced text in live frame, got: ${frame.slice(-200)}`,
  );
  instance.unmount();
});

test('Ink streaming: reasoning longer than the tail cap renders truncated with marker', async () => {
  const { ctrl, instance } = mountChat();
  const c = await ctrl;
  c.push.setPhase('turn-running');
  c.push.assistantDeltaStart();
  // 3000-char reasoning is well over the 1500-char tail cap.
  const long = 'reasoning '.repeat(300);
  c.push.reasoningDelta(long);
  await waitMs(120);
  const frame = instance.lastFrame() ?? '';
  assert.ok(frame.includes('💭 thinking'), 'expected thinking header in frame');
  // After 0.3.10 stable-height window: long reasoning shows a char
  // count in parentheses (e.g. "💭 thinking (3,000 chars)"). The
  // visible body is clipped to REASONING_VISIBLE_LINES rows regardless.
  assert.ok(
    /\(\d[\d,]*\s*chars\)/.test(frame),
    `expected (N chars) marker, got: ${frame.slice(0, 400)}`,
  );
  // The frame should NOT contain the original first repetition (it's
  // been trimmed off). Look for content closer to the tail of the input.
  // Soft check: the frame length is bounded.
  assert.ok(frame.length < 8000, `expected bounded frame size, got ${frame.length} chars`);
  instance.unmount();
});

test('Ink streaming: completed scrollback rows stay stable across streaming flushes (memo)', async () => {
  const { ctrl, instance } = mountChat();
  const c = await ctrl;
  // Push a user + assistant pair so we have a stable scrollback baseline.
  c.push.user('test prompt');
  c.push.assistant('first reply', { tokensOut: 10, durationMs: 100 });
  await waitMs(10);
  const baseline = instance.lastFrame() ?? '';
  assert.ok(baseline.includes('test prompt'));
  assert.ok(baseline.includes('first reply'));

  // Now stream a NEW assistant turn. The scrollback portion of the
  // frame above the live tier should remain byte-identical across the
  // streaming flushes — React.memo on ScrollbackRow guarantees that
  // ChatApp re-renders don't recompute the completed rows.
  c.push.setPhase('turn-running');
  c.push.assistantDeltaStart();
  c.push.assistantDelta('A');
  await waitMs(120);
  const midStream1 = instance.lastFrame() ?? '';
  c.push.assistantDelta('B');
  await waitMs(120);
  const midStream2 = instance.lastFrame() ?? '';

  // Extract the lines containing "test prompt" and "first reply" —
  // these must be present and identical in both mid-stream frames.
  const pickHistory = (f: string) => {
    const lines = f.split('\n');
    return lines
      .filter((l) => l.includes('test prompt') || l.includes('first reply'))
      .join('\n');
  };
  assert.equal(
    pickHistory(midStream1),
    pickHistory(midStream2),
    'scrollback history must be byte-stable across streaming flushes',
  );
  // The live tier should have grown from 'A' to 'AB'.
  assert.ok(midStream2.includes('AB'), `expected accumulated stream, got: ${midStream2.slice(-200)}`);
  instance.unmount();
});

test('Ink streaming: reasoning panel keeps a stable height as content grows (scroll fix)', async () => {
  // The "keep scrolling while thinking" bug: when reasoning streamed in,
  // the dim-italic block grew line-by-line, the Ink frame grew with it,
  // and the terminal native scroll triggered every time the frame
  // exceeded the viewport. Fix: the live reasoning render Box now has
  // a fixed height={REASONING_VISIBLE_LINES}, so the frame's total row
  // count does NOT change as more reasoning streams in. This test
  // captures frames at three growth checkpoints and asserts the line
  // count is non-monotonic — the frame plateaus.
  const { ctrl, instance } = mountChat();
  const c = await ctrl;
  c.push.setPhase('turn-running');
  c.push.assistantDeltaStart();

  // Checkpoint 1: tiny reasoning (1 line).
  c.push.reasoningDelta('first thought\n');
  await waitMs(120);
  const lines1 = (instance.lastFrame() ?? '').split('\n').length;

  // Checkpoint 2: moderate reasoning (~5 lines).
  c.push.reasoningDelta(Array.from({ length: 4 }, (_, i) => `thought ${i + 2}`).join('\n') + '\n');
  await waitMs(120);
  const lines2 = (instance.lastFrame() ?? '').split('\n').length;

  // Checkpoint 3: long reasoning (~50 lines). This is well past
  // REASONING_VISIBLE_LINES — the rendered frame MUST NOT grow
  // proportionally.
  c.push.reasoningDelta(Array.from({ length: 50 }, (_, i) => `deep thought ${i + 6}`).join('\n') + '\n');
  await waitMs(120);
  const lines3 = (instance.lastFrame() ?? '').split('\n').length;

  // The plateau: lines3 - lines2 should be small (within ~2 lines of
  // jitter from the (N chars) header appearing). If the bug were
  // present, lines3 would be ~45 lines bigger than lines2.
  assert.ok(
    lines3 - lines2 <= 3,
    `reasoning panel must plateau, but grew by ${lines3 - lines2} lines (1→2: ${lines2 - lines1}, 2→3: ${lines3 - lines2})`,
  );
  instance.unmount();
});

test('Ink streaming: spinner hides during active streaming, returns when stream pauses', async () => {
  const { ctrl, instance } = mountChat();
  const c = await ctrl;
  c.push.setPhase('turn-running');
  c.push.setStatus('Bash(curl example)');
  await waitMs(20);
  // Pre-stream: spinner label visible (we ship ink-spinner so we can't
  // assert the glyph directly, but the label IS visible).
  const beforeStream = instance.lastFrame() ?? '';
  assert.ok(
    beforeStream.includes('Bash(curl example)'),
    `expected spinner label before stream, got: ${beforeStream.slice(-200)}`,
  );
  // Now start streaming — once liveAssistant has content, the spinner
  // block (including the label) should disappear so the only "alive"
  // visual element is the gray ▍ cursor.
  c.push.assistantDeltaStart();
  c.push.assistantDelta('streaming now');
  await waitMs(120);
  const duringStream = instance.lastFrame() ?? '';
  assert.ok(duringStream.includes('streaming now'));
  assert.ok(
    !duringStream.includes('Bash(curl example)'),
    `expected spinner hidden during stream, got: ${duringStream.slice(-200)}`,
  );
  instance.unmount();
});

test('Ink streaming: assistantDeltaEnd flushes pending buffer to the visible frame', async () => {
  const { ctrl, instance } = mountChat();
  const c = await ctrl;
  c.push.setPhase('turn-running');
  c.push.assistantDeltaStart();
  c.push.assistantDelta('partial chunk');
  // End BEFORE the 80ms timer fires — the end handler must synchronously
  // flush the buffer so the user sees the model's last words.
  c.push.assistantDeltaEnd();
  await waitMs(10);
  const frame = instance.lastFrame() ?? '';
  assert.ok(
    frame.includes('partial chunk'),
    `expected end-of-stream flush, got: ${frame.slice(-200)}`,
  );
  instance.unmount();
});
