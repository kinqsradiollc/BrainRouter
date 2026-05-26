import React from 'react';
import { Picker, type PickerProps, type PickerResult, type PickerRow } from './Picker.js';
import { TextField, type TextFieldProps, type TextFieldResult } from './TextField.js';
import { NoTTYError } from '../cliPrompt.js';
import { resetStdinForReadline, snapshotStdinListeners } from './stdinHandoff.js';
import { getAmbientChat } from './ambientChat.js';
import { renderWithResizeClear } from './renderWithResizeClear.js';

/**
 * One-shot Ink mount helpers. Used by `/config`, `/login`, and any
 * slash command that needs a single picker / text prompt without
 * managing Ink lifecycle by hand.
 *
 * Two paths:
 *
 *   1. **Overlay path** — when the Ink chat REPL is running, the
 *      ambient ChatController is set (see ambientChat.ts +
 *      runChat.tsx). We render <Picker> inside the chat's overlay
 *      slot, NOT as a second Ink mount — that would race the chat
 *      for stdin + terminal state and break the picker's interaction.
 *
 *   2. **Standalone path** — for the legacy readline REPL, mount a
 *      fresh Ink instance. Unmount via `instance.unmount()` from
 *      outside the React tree (no `useApp().exit()`) so the wrapper
 *      doesn't risk exiting the wrong Ink instance if something goes
 *      sideways. The Picker/TextField components are exit-agnostic;
 *      they call onResolve and trust the caller to handle unmount.
 *
 * Stdin handoff for the standalone path: snapshot + detach existing
 * listeners before mount, restore them and reset stdin state after
 * Ink unmounts (matches the pattern in runWizard.tsx / runSlashPalette).
 */

// --- Picker -----------------------------------------------------------

export async function runPicker(opts: Omit<PickerProps, 'onResolve'>): Promise<PickerResult> {
  // OVERLAY PATH — running inside the Ink chat REPL.
  const ambient = getAmbientChat();
  if (ambient) {
    return new Promise<PickerResult>((resolve) => {
      let resolved = false;
      const overlayNode = (
        <Picker
          {...opts}
          onResolve={(r) => {
            if (resolved) return;
            resolved = true;
            ambient.clearOverlay();
            resolve(r);
          }}
        />
      );
      ambient.showOverlay(overlayNode).catch(() => {
        if (!resolved) {
          resolved = true;
          resolve({ kind: 'cancelled' });
        }
      });
    });
  }

  // STANDALONE PATH — readline REPL fallback. Mounts a fresh Ink.
  if (!process.stdin.isTTY) {
    throw new NoTTYError('runPicker requires an interactive TTY.');
  }
  const snap = snapshotStdinListeners(['keypress', 'data']);
  return new Promise<PickerResult>((resolve) => {
    let captured: PickerResult | undefined;
    // We need `instance` inside the onResolve closure but it doesn't
    // exist yet when we build the JSX. Use a forward-declared variable
    // that the closure captures by reference and we assign before the
    // user can possibly interact with the picker. instance.unmount()
    // is cleaner than useApp().exit() — works even if the Picker
    // somehow ends up rendered in the wrong Ink tree.
    let instance: ReturnType<typeof renderWithResizeClear>['instance'];
    const node = (
      <Picker
        {...opts}
        onResolve={(r) => {
          if (!captured) captured = r;
          if (instance) instance.unmount();
        }}
      />
    );
    const mounted = renderWithResizeClear(node, { exitOnCtrlC: true });
    instance = mounted.instance;
    instance.waitUntilExit().then(() => {
      mounted.cleanupResizeClear();
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    }).catch(() => {
      mounted.cleanupResizeClear();
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    });
  });
}

// --- TextField --------------------------------------------------------

export async function runTextField(opts: Omit<TextFieldProps, 'onResolve'>): Promise<TextFieldResult> {
  // OVERLAY PATH
  const ambient = getAmbientChat();
  if (ambient) {
    return new Promise<TextFieldResult>((resolve) => {
      let resolved = false;
      const overlayNode = (
        <TextField
          {...opts}
          onResolve={(r) => {
            if (resolved) return;
            resolved = true;
            ambient.clearOverlay();
            resolve(r);
          }}
        />
      );
      ambient.showOverlay(overlayNode).catch(() => {
        if (!resolved) {
          resolved = true;
          resolve({ kind: 'cancelled' });
        }
      });
    });
  }

  // STANDALONE PATH
  if (!process.stdin.isTTY) {
    throw new NoTTYError('runTextField requires an interactive TTY.');
  }
  const snap = snapshotStdinListeners(['keypress', 'data']);
  return new Promise<TextFieldResult>((resolve) => {
    let captured: TextFieldResult | undefined;
    let instance: ReturnType<typeof renderWithResizeClear>['instance'];
    const node = (
      <TextField
        {...opts}
        onResolve={(r) => {
          if (!captured) captured = r;
          if (instance) instance.unmount();
        }}
      />
    );
    const mounted = renderWithResizeClear(node, { exitOnCtrlC: true });
    instance = mounted.instance;
    instance.waitUntilExit().then(() => {
      mounted.cleanupResizeClear();
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    }).catch(() => {
      mounted.cleanupResizeClear();
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    });
  });
}

/** Re-export the shared types so callers don't import from picker.tsx directly. */
export type { PickerRow, PickerResult } from './Picker.js';
export type { TextFieldResult } from './TextField.js';
