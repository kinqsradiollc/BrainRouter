import readline from 'node:readline';

/**
 * Shared bridge between the REPL's readline interface and modules outside
 * repl.ts that need to (a) write above the prompt without scrambling input,
 * or (b) ask the user a one-shot question while a turn is in progress
 * (e.g. run_command approval).
 *
 * Previously this used `inquirer.prompt`. Inquirer creates its OWN readline
 * interface attached to the same `process.stdin`, and on exit it leaves stray
 * `line` events that the parent REPL then sees as "the user typed a new
 * prompt while a turn is still running". Using the parent rl directly avoids
 * that.
 *
 * Only one REPL exists per process, so a module-level pointer is fine.
 */

let activeReadline: readline.Interface | undefined;

export function setActiveReadline(rl: readline.Interface | undefined): void {
  activeReadline = rl;
}

export function getActiveReadline(): readline.Interface | undefined {
  return activeReadline;
}

/**
 * True while `askChoice` is rendering its raw-mode picker. The REPL's own
 * keypress handler (shift+tab access-mode cycle) checks this and yields,
 * so the picker has uncontested control of stdin while it's active.
 */
let pickerActive = false;
export function isPickerActive(): boolean { return pickerActive; }

/**
 * One-shot yes/no question. Returns true only when the user types y/yes
 * (case-insensitive). Returns the supplied default when stdin isn't a TTY
 * (e.g. piped non-interactive runs).
 */
export function askYesNo(question: string, defaultValue = false): Promise<boolean> {
  if (!activeReadline || !process.stdin.isTTY) {
    return Promise.resolve(defaultValue);
  }
  return new Promise((resolve) => {
    const rl = activeReadline!;
    // The parent rl was paused by runAgentTurn; resume so it actually reads
    // keystrokes. We re-pause once we have the answer.
    rl.resume();
    rl.question(question, (answer) => {
      const lower = (answer ?? '').trim().toLowerCase();
      const yes = lower === 'y' || lower === 'yes';
      rl.pause();
      resolve(yes);
    });
  });
}

/**
 * Surfaced when `askChoice` is called outside an interactive TTY. The tool
 * wrapper turns this into a tool-call error so the LLM falls back to deciding
 * itself — silently picking option 1 for the agent in CI / piped runs would
 * make a load-bearing decision the user never saw.
 */
export class NoTTYError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoTTYError';
  }
}

/**
 * Surfaced when the user pressed Esc / q / Ctrl+C inside the picker.
 * The tool wrapper converts this into a tool-call error so the LLM knows
 * the user declined to commit and can re-plan instead of guessing.
 */
export class CancelledChoiceError extends Error {
  constructor(message = 'ask_user_choice was cancelled by the user before they picked an option.') {
    super(message);
    this.name = 'CancelledChoiceError';
  }
}

export interface ChoiceOption {
  label: string;
  description: string;
}

// --- Pure picker state machine -------------------------------------------
// Split out as exported pure functions so they're trivial to unit-test
// without faking a TTY or piping through keypress events. The orchestrator
// (`askChoice`) only owns the side-effecting bits: wiring stdin keypress
// events into the reducer and re-rendering the screen.

/** Synthetic always-on "Other" option appended to every picker. */
const OTHER_LABEL = 'Other';
const OTHER_DESCRIPTION = 'Type a free-form answer not listed above';

export interface PickerState {
  /** Includes the synthetic Other entry at the last index. */
  options: ChoiceOption[];
  cursor: number;
  multiSelect: boolean;
  /** Indices of options the user has toggled on (multi-select only). */
  selected: Set<number>;
  /** True once the user confirmed Other and we're collecting free text. */
  awaitingOther: boolean;
  /** Accumulated free-text for the Other prompt. */
  otherText: string;
  done: boolean;
  cancelled: boolean;
  /** Final resolved value when `done && !cancelled`. */
  result: string | string[] | null;
}

/** Normalized keystroke shape the reducer consumes. Decoupled from Node's
 * raw `keypress` event so the reducer can be driven by test inputs that
 * don't go through `emitKeypressEvents`. */
export interface PickerKey {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
  /** A single printable character for free-text capture (Other phase). */
  char?: string;
}

/**
 * `prefilledOther` drops the picker straight into the free-text "Other"
 * phase with the supplied string already in the buffer. Used by the
 * 0.3.7 wizard / `/config` panel when a value can be derived from an
 * env var — the user sees the env value and presses ENTER to accept or
 * edits to override. Pass an empty string to keep today's behaviour.
 *
 * `initialCursor` lets a picker open with a non-zero highlight so the
 * settings home panel can re-open on the row the user just edited
 * without re-scrolling them to the top.
 */
export interface InitPickerStateOptions {
  prefilledOther?: string;
  initialCursor?: number;
}

export function initPickerState(
  options: ChoiceOption[],
  multiSelect: boolean,
  init: InitPickerStateOptions = {},
): PickerState {
  const augmented = [...options, { label: OTHER_LABEL, description: OTHER_DESCRIPTION }];
  const otherText = init.prefilledOther ?? '';
  const awaitingOther = otherText.length > 0;
  // When pre-filled "Other" is requested, position the cursor on the
  // Other row so a subsequent Esc → re-render lands the user there
  // (otherwise they'd snap back to row 0 with no explanation).
  const cursor = awaitingOther
    ? augmented.length - 1
    : Math.max(0, Math.min(init.initialCursor ?? 0, augmented.length - 1));
  return {
    options: augmented,
    cursor,
    multiSelect,
    selected: new Set<number>(),
    awaitingOther,
    otherText,
    done: false,
    cancelled: false,
    result: null,
  };
}

function finalizeWithOther(state: PickerState, text: string): PickerState {
  if (state.multiSelect) {
    const otherIdx = state.options.length - 1;
    const indices = Array.from(state.selected).sort((a, b) => a - b);
    const labels = indices.map((i) => (i === otherIdx ? text : state.options[i].label));
    return { ...state, done: true, result: labels, otherText: text };
  }
  return { ...state, done: true, result: text, otherText: text };
}

export function reducePicker(state: PickerState, key: PickerKey): PickerState {
  if (state.done) return state;
  // Ctrl+C always cancels, in any phase. Don't gate on `key.name === 'c'`
  // alone — some terminals send the sequence without a named binding.
  if (key.ctrl && (key.name === 'c' || key.sequence === '')) {
    return { ...state, done: true, cancelled: true };
  }

  // --- Free-text "Other" phase ------------------------------------------
  if (state.awaitingOther) {
    if (key.name === 'return' || key.sequence === '\r' || key.sequence === '\n') {
      const text = state.otherText.trim();
      if (!text) return state; // empty ENTER is a no-op so the user can retry
      return finalizeWithOther(state, text);
    }
    if (key.name === 'backspace') {
      return { ...state, otherText: state.otherText.slice(0, -1) };
    }
    if (key.name === 'escape') {
      // Bail back to the picker so a stray ENTER on Other isn't a one-way trip.
      return { ...state, awaitingOther: false, otherText: '' };
    }
    if (key.char && key.char.length === 1) {
      return { ...state, otherText: state.otherText + key.char };
    }
    return state;
  }

  // --- Picker phase -----------------------------------------------------
  switch (key.name) {
    case 'up':
      return { ...state, cursor: (state.cursor - 1 + state.options.length) % state.options.length };
    case 'down':
      return { ...state, cursor: (state.cursor + 1) % state.options.length };
    case 'space': {
      if (!state.multiSelect) return state;
      const next = new Set(state.selected);
      if (next.has(state.cursor)) next.delete(state.cursor);
      else next.add(state.cursor);
      return { ...state, selected: next };
    }
    case 'return': {
      const otherIdx = state.options.length - 1;
      if (state.multiSelect) {
        // Confirming with nothing selected is a no-op — the user must SPACE
        // at least one row first. Bailing here keeps "I pressed ENTER too
        // soon" from silently committing to an empty array.
        if (state.selected.size === 0) return state;
        if (state.selected.has(otherIdx)) {
          return { ...state, awaitingOther: true };
        }
        const indices = Array.from(state.selected).sort((a, b) => a - b);
        return { ...state, done: true, result: indices.map((i) => state.options[i].label) };
      }
      if (state.cursor === otherIdx) {
        return { ...state, awaitingOther: true };
      }
      return { ...state, done: true, result: state.options[state.cursor].label };
    }
    case 'escape':
    case 'q':
      return { ...state, done: true, cancelled: true };
  }
  return state;
}

export function renderPicker(state: PickerState, question: string, header?: string): string {
  const lines: string[] = [];
  if (header) lines.push(`[${header}]`);
  lines.push(question);
  lines.push('');
  for (let i = 0; i < state.options.length; i++) {
    const opt = state.options[i];
    const cursor = i === state.cursor ? '▶' : ' ';
    const mark = state.multiSelect ? (state.selected.has(i) ? '☑ ' : '☐ ') : '';
    lines.push(`  ${cursor} ${mark}${opt.label}  —  ${opt.description}`);
  }
  lines.push('');
  if (state.awaitingOther) {
    lines.push('[Other] Type your answer and press ENTER  ·  Backspace to edit  ·  Esc to go back');
    lines.push(`> ${state.otherText}_`);
  } else if (state.multiSelect) {
    lines.push('↑/↓ navigate  ·  SPACE toggle  ·  ENTER confirm  ·  q to cancel');
  } else {
    lines.push('↑/↓ navigate  ·  ENTER confirm  ·  q to cancel');
  }
  return lines.join('\n');
}

/**
 * Mid-turn multi-choice prompt with arrow-key navigation, a checkbox UI
 * for multi-select, and an always-on "Other" option that drops to free-text
 * input. Pause/resume the parent REPL the same way `askYesNo` does, so it
 * composes cleanly with the existing readline bridge.
 *
 * Non-TTY behavior is strict: throws `NoTTYError` instead of defaulting to
 * option 1. The agent calling this is asking the human for judgment; making
 * the call for them in CI / piped / `brainrouter run` would silently commit
 * to a path the user never saw.
 *
 * User cancellation (Esc, q, Ctrl+C) throws `CancelledChoiceError` so the
 * tool wrapper can surface "user declined to commit" as a tool-call error.
 */
/**
 * 0.3.7 picker opts.
 *
 * `onCursorChange(index)` fires after every arrow-key move that actually
 * moves the cursor (no-op keys, ENTER, SPACE don't fire it). The 0.3.7
 * theme picker uses this to live-preview the selected theme by redrawing
 * the banner accent before the user confirms — pattern lifted from
 * `openSrc/codex/codex-rs/tui/src/bottom_pane/list_selection_view.rs` and
 * `openSrc/codex/codex-rs/tui/src/theme_picker.rs`.
 *
 * `prefilledOther` opens the picker with the synthetic "Other" row
 * already selected AND the free-text input pre-filled. Used when a value
 * is derived from an env var so the user can press ENTER to accept or
 * edit in-place. Pre-fill flips `awaitingOther` true on init.
 *
 * `initialCursor` lets the settings home panel re-open on the row the
 * user just left, avoiding a snap-to-row-0 after every sub-picker.
 */
export interface AskChoiceOptions {
  multiSelect?: boolean;
  header?: string;
  onCursorChange?: (cursor: number) => void;
  prefilledOther?: string;
  initialCursor?: number;
}

export function askChoice(
  question: string,
  options: ChoiceOption[],
  opts: AskChoiceOptions = {},
): Promise<string | string[]> {
  // Input-shape validation first — bad shape is a caller bug regardless of
  // TTY availability, and surfacing it as "no TTY" would misdirect the agent
  // toward "decide yourself" when the real fix is "re-emit the call with a
  // valid options array".
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    const count = Array.isArray(options) ? options.length : 'invalid';
    return Promise.reject(
      new Error(`ask_user_choice requires 2–4 options; received ${count}.`),
    );
  }
  // Reject duplicate labels (case-insensitive). The picker shows labels as
  // the human-readable identifier and returns them as the result, so two
  // options with the same label make the return value ambiguous and downstream
  // branching unreliable. Catch it here, not after the picker is half-drawn.
  // The synthetic "Other" option also collides with a user-supplied "other",
  // so reject that too.
  const seen = new Set<string>();
  for (const o of options) {
    const key = (o?.label ?? '').toLowerCase();
    if (key === OTHER_LABEL.toLowerCase()) {
      return Promise.reject(
        new Error(`ask_user_choice cannot use "${o.label}" as a label — "${OTHER_LABEL}" is reserved for the always-on free-text fallback.`),
      );
    }
    if (seen.has(key)) {
      return Promise.reject(
        new Error(`ask_user_choice options must have unique labels; "${o.label}" appears more than once (case-insensitive).`),
      );
    }
    seen.add(key);
  }
  if (!activeReadline || !process.stdin.isTTY) {
    return Promise.reject(
      new NoTTYError(
        'ask_user_choice requires an interactive TTY (no readline interface is active or stdin is not a TTY). ' +
        'Fall back to deciding yourself based on the available context, and state which option you picked and why in your reply.',
      ),
    );
  }
  return runPicker(question, options, opts);
}

function runPicker(
  question: string,
  options: ChoiceOption[],
  opts: AskChoiceOptions,
): Promise<string | string[]> {
  return new Promise((resolve, reject) => {
    const rl = activeReadline!;
    const stdout = process.stdout;
    let state = initPickerState(options, !!opts.multiSelect, {
      prefilledOther: opts.prefilledOther,
      initialCursor: opts.initialCursor,
    });
    let renderedLines = 0;

    // Pause the parent rl so its `line` handler doesn't fire on our ENTER
    // press. We restore on cleanup.
    rl.pause();

    // readline.createInterface already calls emitKeypressEvents and sets raw
    // mode for a TTY input; this is belt-and-suspenders for cases where the
    // parent code disabled raw mode somewhere along the way.
    readline.emitKeypressEvents(process.stdin);
    try { (process.stdin as any).setRawMode?.(true); } catch { /* not a real TTY */ }
    process.stdin.resume();
    // Hide cursor while the picker is on screen — keeps the rendering tight.
    stdout.write('\x1b[?25l');
    pickerActive = true;

    const clear = () => {
      if (renderedLines > 0) {
        // Move cursor up `renderedLines` then clear to end of screen.
        stdout.write(`\x1b[${renderedLines}A\r\x1b[J`);
      }
    };
    const render = () => {
      clear();
      const text = renderPicker(state, question, opts.header);
      stdout.write(text + '\n');
      renderedLines = text.split('\n').length;
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      // Restore cursor visibility. Leave raw mode TRUE — the REPL expects it
      // on (Backspace + arrow keys + readline's editing all rely on raw mode)
      // and a previous version that restored a captured `wasRaw` flipped raw
      // mode back to false in terminals where readline's auto-init never
      // fully engaged, which manifested as Backspace echoing `^?` after the
      // picker exited. Picker is the one component that's GUARANTEED to know
      // raw mode is needed, so it's the right place to assert the invariant.
      stdout.write('\x1b[?25h');
      try { (process.stdin as any).setRawMode?.(true); } catch { /* noop */ }
      pickerActive = false;
      // Don't auto-resume the parent rl — runAgentTurn paused it intentionally
      // and will resume on its own schedule.
    };

    const onKeypress = (str: string | undefined, key: any) => {
      const named = key?.name;
      const isPrintable = typeof str === 'string'
        && str.length === 1
        && !key?.ctrl
        && named !== 'return'
        && named !== 'escape'
        && named !== 'backspace'
        && named !== 'tab';
      const pk: PickerKey = {
        name: named,
        ctrl: !!key?.ctrl,
        sequence: key?.sequence,
        char: isPrintable ? str : undefined,
      };
      const prevCursor = state.cursor;
      const wasAwaitingOther = state.awaitingOther;
      const nextState = reducePicker(state, pk);
      if (nextState === state) return;
      state = nextState;
      // Live-preview hook (0.3.7): fire on a genuine cursor move in the
      // picker phase only. Don't fire while collecting free-text in the
      // "Other" phase — that would spam the callback on every keystroke
      // for no useful signal. Settling back into picker phase from Other
      // (Esc) doesn't fire either (the cursor "stayed" on Other).
      if (
        opts.onCursorChange
        && !state.done
        && !state.awaitingOther
        && !wasAwaitingOther
        && state.cursor !== prevCursor
      ) {
        try { opts.onCursorChange(state.cursor); } catch { /* preview callbacks must never crash the picker */ }
      }
      render();
      if (state.done) {
        cleanup();
        if (state.cancelled) {
          reject(new CancelledChoiceError());
        } else {
          resolve(state.result!);
        }
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}

/**
 * Print a line of output while the prompt is showing, then redraw the prompt
 * with whatever the user was mid-typing. Used by callbacks that fire while the
 * REPL is idle (child agents that complete async after the parent turn ended).
 */
export function safePrintAbovePrompt(msg: string): void {
  if (!process.stdout.isTTY || !activeReadline) {
    console.log(msg);
    return;
  }
  process.stdout.write('\r\x1b[2K');
  console.log(msg);
  try { (activeReadline as any)._refreshLine?.(); } catch { activeReadline.prompt(true); }
}
