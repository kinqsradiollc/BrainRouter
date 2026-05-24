import React from 'react';
import { render } from 'ink';
import { Picker, type PickerProps, type PickerResult, type PickerRow } from './Picker.js';
import { TextField, type TextFieldProps, type TextFieldResult } from './TextField.js';
import { NoTTYError } from '../cliPrompt.js';
import { resetStdinForReadline, snapshotStdinListeners } from './stdinHandoff.js';

/**
 * One-shot Ink mount helpers. Used by `/config`, `/login`, and any
 * slash command that needs a single picker / text prompt without
 * managing Ink lifecycle by hand.
 *
 * Both helpers handle the stdin handoff in one place: snapshot +
 * detach existing stdin listeners before mount, restore them and
 * reset stdin state after Ink unmounts. Without this the surrounding
 * REPL would either fight with Ink for keystrokes (listeners
 * conflict) or exit immediately after unmount (Ink's `stdin.unref()`
 * drops the event-loop refcount).
 */

export async function runPicker(opts: Omit<PickerProps, 'onResolve'>): Promise<PickerResult> {
  if (!process.stdin.isTTY) {
    throw new NoTTYError('runPicker requires an interactive TTY.');
  }
  const snap = snapshotStdinListeners(['keypress', 'data']);
  return new Promise<PickerResult>((resolve) => {
    let captured: PickerResult | undefined;
    const instance = render(
      <Picker {...opts} onResolve={(r) => { if (!captured) captured = r; }} />,
      { exitOnCtrlC: true },
    );
    instance.waitUntilExit().then(() => {
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    }).catch(() => {
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    });
  });
}

export async function runTextField(opts: Omit<TextFieldProps, 'onResolve'>): Promise<TextFieldResult> {
  if (!process.stdin.isTTY) {
    throw new NoTTYError('runTextField requires an interactive TTY.');
  }
  const snap = snapshotStdinListeners(['keypress', 'data']);
  return new Promise<TextFieldResult>((resolve) => {
    let captured: TextFieldResult | undefined;
    const instance = render(
      <TextField {...opts} onResolve={(r) => { if (!captured) captured = r; }} />,
      { exitOnCtrlC: true },
    );
    instance.waitUntilExit().then(() => {
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    }).catch(() => {
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    });
  });
}

/** Re-export the shared types so callers don't import from picker.tsx directly. */
export type { PickerRow, PickerResult } from './Picker.js';
export type { TextFieldResult } from './TextField.js';
