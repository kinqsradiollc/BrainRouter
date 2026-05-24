import React from 'react';
import { render } from 'ink';
import { Picker, type PickerProps, type PickerResult, type PickerRow } from './Picker.js';
import { TextField, type TextFieldProps, type TextFieldResult } from './TextField.js';
import { NoTTYError } from '../cliPrompt.js';

/**
 * One-shot Ink mount helpers. Used by `/config`, `/login`, and any
 * slash command that needs a single picker / text prompt without
 * managing Ink lifecycle by hand.
 *
 * Pattern: mount → resolve on first user decision → unmount.
 *
 * Why a wrapper? Ink owns stdout while mounted — we want each
 * picker / prompt to be a discrete modal: mount, render, await
 * one decision, unmount. The wrapper handles all that so the
 * callers (/config home panel, /login transport picker, etc.)
 * read like ordinary `await`s.
 */

export async function runPicker(opts: Omit<PickerProps, 'onResolve'>): Promise<PickerResult> {
  if (!process.stdin.isTTY) {
    throw new NoTTYError('runPicker requires an interactive TTY.');
  }
  return new Promise<PickerResult>((resolve) => {
    let resolved = false;
    const onResolve = (r: PickerResult) => {
      if (resolved) return;
      resolved = true;
      // Unmount on the next tick so Ink finishes its last redraw
      // before we yank stdin away from it.
      setImmediate(() => instance.unmount());
      resolve(r);
    };
    const instance = render(<Picker {...opts} onResolve={onResolve} />, { exitOnCtrlC: true });
    instance.waitUntilExit().catch(() => { /* swallow */ });
  });
}

export async function runTextField(opts: Omit<TextFieldProps, 'onResolve'>): Promise<TextFieldResult> {
  if (!process.stdin.isTTY) {
    throw new NoTTYError('runTextField requires an interactive TTY.');
  }
  return new Promise<TextFieldResult>((resolve) => {
    let resolved = false;
    const onResolve = (r: TextFieldResult) => {
      if (resolved) return;
      resolved = true;
      setImmediate(() => instance.unmount());
      resolve(r);
    };
    const instance = render(<TextField {...opts} onResolve={onResolve} />, { exitOnCtrlC: true });
    instance.waitUntilExit().catch(() => { /* swallow */ });
  });
}

/** Re-export the shared types so callers don't import from picker.tsx directly. */
export type { PickerRow, PickerResult } from './Picker.js';
export type { TextFieldResult } from './TextField.js';
