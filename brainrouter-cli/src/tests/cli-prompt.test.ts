import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_TOOLS } from '../agent/agent.js';
import {
  askChoice,
  CancelledChoiceError,
  initPickerState,
  NoTTYError,
  reducePicker,
  renderPicker,
  setActiveReadline,
} from '../cli/cliPrompt.js';
import { ARTIFACT, createWorkflow, getWorkflowDir } from '../state/workflowArtifacts.js';
import { withTempWorkspace } from './_helpers.js';

// --- askChoice / ask_user_choice -----------------------------------------
// The interactive picker is split into a pure reducer + renderer plus an
// orchestrator that wires stdin keypress events into them. We test the
// pure parts directly (no TTY mocking required) and rely on a single
// integration test for the eager non-TTY guard in `askChoice`. The picker's
// raw-mode rendering itself is too tied to terminal escape sequences to
// be worth simulating in tests; trust the pure pieces + manual smoke.

const SAMPLE_OPTIONS = [
  { label: 'React', description: 'SPA with hooks' },
  { label: 'Svelte', description: 'Compiled reactive components' },
  { label: 'Vue', description: 'Template-driven SFCs' },
];

test('initPickerState: appends a synthetic "Other" option at the end', () => {
  const s = initPickerState(SAMPLE_OPTIONS, false);
  assert.equal(s.options.length, 4, 'three options + Other');
  assert.equal(s.options[3].label, 'Other');
  assert.equal(s.cursor, 0);
  assert.equal(s.done, false);
  assert.equal(s.multiSelect, false);
});

test('reducePicker: down/up navigates and wraps around the option list', () => {
  let s = initPickerState(SAMPLE_OPTIONS, false);
  s = reducePicker(s, { name: 'down' });
  assert.equal(s.cursor, 1);
  s = reducePicker(s, { name: 'down' });
  s = reducePicker(s, { name: 'down' });
  s = reducePicker(s, { name: 'down' });
  // Wraps back to 0 (4 options total including Other).
  assert.equal(s.cursor, 0);
  s = reducePicker(s, { name: 'up' });
  assert.equal(s.cursor, 3, 'wrap upward to the last (Other) row');
});

test('reducePicker: ENTER on a regular option finalizes with that label', () => {
  let s = initPickerState(SAMPLE_OPTIONS, false);
  s = reducePicker(s, { name: 'down' }); // Svelte
  s = reducePicker(s, { name: 'return' });
  assert.equal(s.done, true);
  assert.equal(s.cancelled, false);
  assert.equal(s.result, 'Svelte');
});

test('reducePicker: ENTER on Other transitions to free-text phase, then ENTER on typed text finalizes', () => {
  let s = initPickerState(SAMPLE_OPTIONS, false);
  // Move cursor to Other (index 3).
  for (let i = 0; i < 3; i++) s = reducePicker(s, { name: 'down' });
  assert.equal(s.options[s.cursor].label, 'Other');
  s = reducePicker(s, { name: 'return' });
  assert.equal(s.awaitingOther, true);
  assert.equal(s.done, false);
  // Type "Qwik" character-by-character.
  for (const ch of 'Qwik') s = reducePicker(s, { char: ch });
  assert.equal(s.otherText, 'Qwik');
  s = reducePicker(s, { name: 'return' });
  assert.equal(s.done, true);
  assert.equal(s.result, 'Qwik');
});

test('reducePicker: Backspace in Other phase erases the last char; Esc bails back to picker', () => {
  let s = initPickerState(SAMPLE_OPTIONS, false);
  for (let i = 0; i < 3; i++) s = reducePicker(s, { name: 'down' });
  s = reducePicker(s, { name: 'return' });
  for (const ch of 'abc') s = reducePicker(s, { char: ch });
  s = reducePicker(s, { name: 'backspace' });
  assert.equal(s.otherText, 'ab');
  s = reducePicker(s, { name: 'escape' });
  assert.equal(s.awaitingOther, false, 'Esc returns to picker');
  assert.equal(s.otherText, '', 'and clears the half-typed text');
  assert.equal(s.done, false);
});

test('reducePicker: empty ENTER in Other phase is a no-op (forces a real answer)', () => {
  let s = initPickerState(SAMPLE_OPTIONS, false);
  for (let i = 0; i < 3; i++) s = reducePicker(s, { name: 'down' });
  s = reducePicker(s, { name: 'return' });
  const before = s;
  const after = reducePicker(s, { name: 'return' });
  assert.equal(after, before, 'empty ENTER must not advance state');
});

test('reducePicker: SPACE toggles in multi-select; ENTER returns the array of picked labels in option order', () => {
  let s = initPickerState(SAMPLE_OPTIONS, true);
  s = reducePicker(s, { name: 'space' }); // React on
  s = reducePicker(s, { name: 'down' });
  s = reducePicker(s, { name: 'down' });
  s = reducePicker(s, { name: 'space' }); // Vue on
  s = reducePicker(s, { name: 'space' }); // Vue off
  s = reducePicker(s, { name: 'space' }); // Vue on again
  s = reducePicker(s, { name: 'return' });
  assert.equal(s.done, true);
  // Ordered by option index — not selection order — so the agent always
  // sees a stable shape.
  assert.deepEqual(s.result, ['React', 'Vue']);
});

test('reducePicker: multi-select ENTER with no selection is a no-op (force the user to pick at least one)', () => {
  const s0 = initPickerState(SAMPLE_OPTIONS, true);
  const s1 = reducePicker(s0, { name: 'return' });
  assert.equal(s1, s0, 'empty multi-select ENTER must not advance state');
});

test('reducePicker: multi-select with Other ticked drops to free text, then ENTER finalizes with the typed string replacing "Other"', () => {
  let s = initPickerState(SAMPLE_OPTIONS, true);
  s = reducePicker(s, { name: 'space' }); // React on
  // Move to Other and toggle on.
  for (let i = 0; i < 3; i++) s = reducePicker(s, { name: 'down' });
  s = reducePicker(s, { name: 'space' });
  s = reducePicker(s, { name: 'return' });
  assert.equal(s.awaitingOther, true);
  for (const ch of 'Qwik') s = reducePicker(s, { char: ch });
  s = reducePicker(s, { name: 'return' });
  assert.equal(s.done, true);
  // React was selected (label preserved); Other was selected and replaced
  // with the typed string.
  assert.deepEqual(s.result, ['React', 'Qwik']);
});

test('reducePicker: q and Ctrl+C both cancel and surface as cancelled (not done with a result)', () => {
  let s = initPickerState(SAMPLE_OPTIONS, false);
  s = reducePicker(s, { name: 'q' });
  assert.equal(s.done, true);
  assert.equal(s.cancelled, true);
  assert.equal(s.result, null);

  let s2 = initPickerState(SAMPLE_OPTIONS, true);
  s2 = reducePicker(s2, { ctrl: true, name: 'c' });
  assert.equal(s2.done, true);
  assert.equal(s2.cancelled, true);
});

test('renderPicker: highlights the cursor row with ▶ and shows checkbox glyphs in multi-select', () => {
  let s = initPickerState(SAMPLE_OPTIONS, true);
  s = reducePicker(s, { name: 'space' }); // tick React
  s = reducePicker(s, { name: 'down' });  // cursor on Svelte
  const out = renderPicker(s, 'Pick frameworks:', 'Stack');
  assert.match(out, /^\[Stack\]/m, 'header chip rendered at top');
  assert.match(out, /Pick frameworks:/);
  // Cursor sits on Svelte (row 2); React (row 1) is ticked but not pointed.
  assert.match(out, /☑ React/);
  assert.match(out, /▶\s+☐ Svelte/);
  assert.match(out, /Other.*free-form/i, 'Other row is rendered');
  assert.match(out, /SPACE toggle/i, 'multi-select footer hint');
});

test('renderPicker: single-select footer hides SPACE-toggle hint', () => {
  const s = initPickerState(SAMPLE_OPTIONS, false);
  const out = renderPicker(s, 'Pick one:');
  assert.doesNotMatch(out, /SPACE/i);
  assert.match(out, /ENTER confirm/);
});

test('renderPicker: free-text phase shows the typed buffer with a cursor marker', () => {
  let s = initPickerState(SAMPLE_OPTIONS, false);
  for (let i = 0; i < 3; i++) s = reducePicker(s, { name: 'down' });
  s = reducePicker(s, { name: 'return' }); // enter awaitingOther
  for (const ch of 'hi') s = reducePicker(s, { char: ch });
  const out = renderPicker(s, 'Pick:');
  assert.match(out, /\[Other\]/);
  assert.match(out, /^> hi_/m, 'typed buffer is echoed with a cursor');
});

test('askChoice: throws NoTTYError when stdin is not a TTY so the agent falls back instead of guessing for the user', async () => {
  setActiveReadline(undefined);
  const prev = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    await assert.rejects(
      () => askChoice('Pick one:', [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ]),
      (err: unknown) => {
        assert.ok(err instanceof NoTTYError);
        assert.match((err as Error).message, /TTY|interactive|fall back/i);
        return true;
      },
    );
  } finally {
    if (prev) Object.defineProperty(process.stdin, 'isTTY', prev);
    else delete (process.stdin as any).isTTY;
  }
});

test('askChoice: rejects 2–4 length violations before touching the screen', async () => {
  await assert.rejects(
    () => askChoice('Pick:', [{ label: 'only', description: 'one' }]),
    /2–4 options/,
  );
  await assert.rejects(
    () => askChoice('Pick:', new Array(5).fill(null).map((_, i) => ({ label: `o${i}`, description: 'x' }))),
    /2–4 options/,
  );
});

test('askChoice: rejects duplicate labels (case-insensitive) before reaching the prompt', async () => {
  // No active readline / TTY needed — input-shape validation fires first.
  setActiveReadline(undefined);
  await assert.rejects(
    () => askChoice('Pick:', [
      { label: 'Apply', description: 'a' },
      { label: 'apply', description: 'b' },
    ]),
    /unique labels|appears more than once/i,
  );
});

test('askChoice: rejects "Other" as a user-supplied label because it collides with the always-on free-text row', async () => {
  setActiveReadline(undefined);
  await assert.rejects(
    () => askChoice('Pick:', [
      { label: 'Approve', description: 'a' },
      { label: 'Other', description: 'something else' },
    ]),
    /reserved|Other/i,
  );
});

// CancelledChoiceError is exported for downstream callers / tool wrappers to
// branch on; this is a sanity-check that the export survives refactors.
test('CancelledChoiceError carries a recognizable name + default message', () => {
  const err = new CancelledChoiceError();
  assert.equal(err.name, 'CancelledChoiceError');
  assert.match(err.message, /cancelled/i);
});

test('LOCAL_TOOLS registers ask_user_choice with the expected schema shape', () => {
  const tool = LOCAL_TOOLS.find((t) => t.name === 'ask_user_choice');
  assert.ok(tool, 'ask_user_choice should be registered in LOCAL_TOOLS');
  const props = (tool!.inputSchema as any).properties;
  assert.ok(props.question, 'schema is missing the `question` property');
  assert.ok(props.header, 'schema is missing the `header` property');
  assert.ok(props.options, 'schema is missing the `options` property');
  assert.equal(props.options.minItems, 2, 'options should require ≥2 items');
  assert.equal(props.options.maxItems, 4, 'options should cap at 4 items');
  const optionItem = props.options.items;
  assert.ok(optionItem.properties.label, 'each option needs a label');
  assert.ok(optionItem.properties.description, 'each option needs a description');
  assert.ok(props.multiSelect, 'multiSelect should be exposed');
  // header is required so the agent always provides a chip-style label,
  // matching the AskUserQuestion shape we're modelling on.
  assert.ok((tool!.inputSchema as any).required.includes('question'));
  assert.ok((tool!.inputSchema as any).required.includes('header'));
  assert.ok((tool!.inputSchema as any).required.includes('options'));
});

// --- /grill-me clarifying-questions slash command ------------------------
// `/grill-me` doesn't render its own picker — it just primes the model to
// emit `ask_user_choice` calls instead of jumping to implementation tools.
// The CLARIFY-mode system overlay is tested in prompt.test.ts; here we
// cover the skip-if-plan-exists guard, which is filesystem-driven (no MCP).

test('grill-me skip guard: fires when the current workflow has a spec.md', async () => {
  const { shouldSkipGrillMe } = await import('../cli/commands/workflow.js');
  withTempWorkspace((workspace) => {
    const meta = createWorkflow(workspace, { title: 'auth rewrite', kind: 'spec' });
    const specAbs = path.join(getWorkflowDir(workspace, meta.slug), ARTIFACT.spec);
    fs.writeFileSync(specAbs, '# Spec\nWhatever.\n');

    const decision = shouldSkipGrillMe(workspace, false);
    assert.equal(decision.skip, true, 'must skip when spec.md is present');
    assert.equal(decision.slug, meta.slug);
    assert.ok(decision.specPath, 'must surface the spec path for the user message');
    assert.match(decision.specPath!, /spec\.md$/);
  });
});

test('grill-me skip guard: stays quiet when no workflow is bound or spec.md is absent', async () => {
  const { shouldSkipGrillMe } = await import('../cli/commands/workflow.js');
  withTempWorkspace((workspace) => {
    // No workflow bound yet → proceed.
    assert.equal(shouldSkipGrillMe(workspace, false).skip, false);

    // Workflow created but spec.md not yet written → proceed (the grill is
    // exactly the right move at this point — clarify before writing the spec).
    createWorkflow(workspace, { title: 'fresh idea', kind: 'feature-dev' });
    assert.equal(shouldSkipGrillMe(workspace, false).skip, false);
  });
});

test('grill-me skip guard: --force bypasses even when a spec.md is present', async () => {
  const { shouldSkipGrillMe } = await import('../cli/commands/workflow.js');
  withTempWorkspace((workspace) => {
    const meta = createWorkflow(workspace, { title: 'follow-up', kind: 'spec' });
    fs.writeFileSync(path.join(getWorkflowDir(workspace, meta.slug), ARTIFACT.spec), '# Spec\n');

    // Without --force we'd skip; with --force the user is explicitly asking
    // for a second clarifying pass, so the guard must yield.
    assert.equal(shouldSkipGrillMe(workspace, false).skip, true);
    assert.equal(shouldSkipGrillMe(workspace, true).skip, false);
  });
});
