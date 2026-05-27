/**
 * Tests for the alt-screen / cursor-hide policy in
 * `renderWithResizeClear`. The default flipped in 0.3.9 to fix the
 * "after a while I can no longer scroll" bug — alt-screen has no
 * scrollback by spec, so users lost mousewheel scroll. Default is
 * now main-screen with `cli.altScreen: true` in
 * `~/.config/brainrouter/config.json` as the opt-in for users who
 * actually need sibling-process isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldHideCursor, shouldUseAltScreen } from '../cli/ink/renderWithResizeClear.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';

function fakeTty(): NodeJS.WriteStream {
  // Just enough surface for `shouldUseAltScreen` / `shouldHideCursor` —
  // both only consult `isTTY` on the supplied stream.
  return { isTTY: true } as unknown as NodeJS.WriteStream;
}

function fakeNonTty(): NodeJS.WriteStream {
  return { isTTY: false } as unknown as NodeJS.WriteStream;
}

function withKnobs(patch: Parameters<typeof setCliKnobOverride>[0], fn: () => void): void {
  try {
    _resetCliKnobsCache();
    setCliKnobOverride(patch);
    fn();
  } finally {
    _resetCliKnobsCache();
  }
}

// --- alt-screen policy ---------------------------------------------------

test('shouldUseAltScreen: default is OFF in 0.3.9+ so native scrollback works', () => {
  withKnobs({}, () => {
    assert.equal(shouldUseAltScreen(fakeTty()), false);
  });
});

test('shouldUseAltScreen: cli.altScreen=true opts in', () => {
  withKnobs({ altScreen: true }, () => {
    assert.equal(shouldUseAltScreen(fakeTty()), true);
  });
});

test('shouldUseAltScreen: non-TTY always returns false (CI / pipes / tests)', () => {
  withKnobs({ altScreen: true }, () => {
    assert.equal(shouldUseAltScreen(fakeNonTty()), false);
  });
});

// --- cursor policy -------------------------------------------------------

test('shouldHideCursor: default ON so the chat REPL has a single visible cursor', () => {
  withKnobs({}, () => {
    assert.equal(shouldHideCursor(fakeTty()), true);
  });
});

test('shouldHideCursor: cli.hideCursor=false keeps the OS cursor visible', () => {
  withKnobs({ hideCursor: false }, () => {
    assert.equal(shouldHideCursor(fakeTty()), false);
  });
});

test('shouldHideCursor: non-TTY always returns false (cursor escape would land in piped output)', () => {
  withKnobs({}, () => {
    assert.equal(shouldHideCursor(fakeNonTty()), false);
  });
});

// --- resize policy ----------------------------------------------------------

test('shouldUseAltScreen drives the resize-handler scrollback wipe', () => {
  // The resize handler ALWAYS calls instance.clear() (required so a
  // width change doesn't leave the prior banner stacking — log-update
  // tracks "previous N lines" at the OLD width). The scrollback wipe
  // (\x1b[3J) is the ONLY part that is alt-screen-conditional:
  //
  //   - alt-screen ON  → wipe scrollback (no user history to lose)
  //   - alt-screen OFF → keep scrollback (user's actual history)
  //
  // The two exported helpers below let tests assert the policy without
  // standing up a real Ink tree.
  withKnobs({}, () => {
    assert.equal(shouldUseAltScreen(fakeTty()), false, 'default in 0.3.9+ is OFF');
  });
  withKnobs({ altScreen: true }, () => {
    assert.equal(shouldUseAltScreen(fakeTty()), true, 'opt-in restores wipe behavior');
  });
});
