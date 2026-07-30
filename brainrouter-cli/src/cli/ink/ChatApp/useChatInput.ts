// REFAC-CHATAPP-SPLIT (0.4.17) — the global keybinding handler, extracted
// verbatim from ChatApp.tsx into a hook. Wraps Ink's `useInput` and owns every
// chat-level keystroke: overlay short-circuit, Ctrl+C/D exit, scroll mode,
// reverse-i-search, verbose toggle, route hotkeys, Ctrl+L clear, access-mode
// cycle, and the @-mention / slash-palette / flag-suggestion / history-recall
// navigation precedence. The body is a byte-for-byte move of the previous
// inline `useInput` callback; only the closed-over state/setters/refs are now
// passed in via a params bag so the precedence is explicit and testable.
import { useInput } from 'ink';
import { historyPrev, historyNext, searchHistory, LIVE } from '../../../runtime/input/inputHistory.js';
import { applyFlagCompletion } from '../../../runtime/input/slashFlags.js';
import { applyAtCompletion } from '../chat/fileIndex.js';
import { type TuiRoute } from '../TuiRouter.js';
import type { SlashCommandDef } from '../prompt/SlashPalette.js';
import type { FlagDef } from '../../../runtime/input/slashFlags.js';
import type { PushScrollback } from './types.js';

export interface ChatInputParams {
  overlay: React.ReactElement | null;
  exit: () => void;
  histSearch: { query: string; skip: number } | null;
  setHistSearch: React.Dispatch<React.SetStateAction<{ query: string; skip: number } | null>>;
  histEntries: string[];
  setComposerProgrammatic: (value: string) => void;
  setVerboseTranscript: React.Dispatch<React.SetStateAction<boolean>>;
  scrollMode: boolean;
  setScrollMode: React.Dispatch<React.SetStateAction<boolean>>;
  scrollMaxRef: React.MutableRefObject<number>;
  viewportBudgetRef: React.MutableRefObject<number>;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  slashQuery: string | null;
  atMatches: string[];
  flagMatches: FlagDef[];
  scrollback: unknown[];
  activeRoute: TuiRoute;
  navigate: (route: TuiRoute) => void;
  setScrollback: React.Dispatch<React.SetStateAction<any[]>>;
  onAccessModeCycle?: () => string;
  setAccessMode: React.Dispatch<React.SetStateAction<'read' | 'write' | 'shell'>>;
  pushFns: PushScrollback;
  atCursor: number;
  setAtCursor: React.Dispatch<React.SetStateAction<number>>;
  setAtDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  composerValue: string;
  paletteMatches: SlashCommandDef[];
  paletteCursor: number;
  setPaletteCursor: React.Dispatch<React.SetStateAction<number>>;
  flagCursor: number;
  setFlagCursor: React.Dispatch<React.SetStateAction<number>>;
  histIndex: number;
  setHistIndex: React.Dispatch<React.SetStateAction<number>>;
  histDraft: string;
  setHistDraft: React.Dispatch<React.SetStateAction<string>>;
}

export function useChatInput(p: ChatInputParams): void {
  // Ctrl+D / Ctrl+C exit; Shift+Tab cycles access mode; while the
  // slash palette is open, arrow keys navigate it and Tab autocompletes
  // the highlighted command into the composer.
  //
  // CRITICAL: when an overlay is active (e.g. /config picker), this
  // handler returns immediately so the overlay's useInput owns every
  // keystroke uncontested. Without this, Ctrl+C / Shift+Tab would
  // still fire from chat-level and cause double-handling — the kind
  // of bug that makes "/config exits to bash" symptoms.
  useInput((input, key) => {
    if (p.overlay !== null) return;
    // Ctrl+C / Ctrl+D always exit, even from scroll mode.
    if (key.ctrl && (input === 'c' || input === 'd')) { p.exit(); return; }
    // SCROLL MODE — toggle with Esc. While on, the composer is INACTIVE
    // (focus=false), so plain keys scroll instead of typing into the prompt:
    //   w / k / ↑ = up · s / j / ↓ = down · g / G = top / bottom · Esc / i / Enter = type
    // This is the only way to scroll with letter keys without them being typed.
    // CC-P1.7 — reverse history search owns the keyboard while active. The
    // composer is defocused (focus prop below), so plain chars build the query
    // instead of typing into the prompt; Ctrl+R cycles older matches; Enter
    // accepts the match into the composer; Esc cancels.
    if (p.histSearch !== null) {
      const match = searchHistory(p.histEntries, p.histSearch.query, p.histSearch.skip);
      if (key.return) {
        if (match) p.setComposerProgrammatic(match.value);
        p.setHistSearch(null);
      } else if (key.escape) {
        p.setHistSearch(null);
      } else if (key.ctrl && (input === 'r' || input === 'R')) {
        p.setHistSearch((h) => h ? { ...h, skip: h.skip + 1 } : h);
      } else if (key.backspace || key.delete) {
        p.setHistSearch((h) => h ? { query: h.query.slice(0, -1), skip: 0 } : h);
      } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
        p.setHistSearch((h) => h ? { query: h.query + input, skip: 0 } : h);
      }
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'R')) {
      p.setHistSearch({ query: '', skip: 0 });
      return;
    }
    // CC-P1.3 — Ctrl+O toggles the verbose transcript (full tool previews).
    if (key.ctrl && (input === 'o' || input === 'O')) {
      p.setVerboseTranscript((v) => !v);
      return;
    }
    if (p.scrollMode) {
      // CC-P1.1 — LINE-granular: w/s move one visual line (holding glides
      // smoothly); PageUp/Dn move a viewport page; g/G jump top/bottom.
      const top = p.scrollMaxRef.current;
      const page = Math.max(3, p.viewportBudgetRef.current - 2);
      if (input === 'w' || input === 'k' || key.upArrow) {
        p.setScrollOffset((prev) => Math.min(top, prev + 1));
      } else if (input === 's' || input === 'j' || key.downArrow) {
        p.setScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.pageUp) {
        p.setScrollOffset((prev) => Math.min(top, prev + page));
      } else if (key.pageDown) {
        p.setScrollOffset((prev) => Math.max(0, prev - page));
      } else if (input === 'g') {
        p.setScrollOffset(top);
      } else if (input === 'G') {
        p.setScrollOffset(0);
      } else if (key.escape || key.return || input === 'i' || input === 'q') {
        p.setScrollMode(false);
      }
      return;
    }
    // Enter scroll mode with Esc when no palette / completion popup owns the key.
    if (key.escape && p.slashQuery === null && p.atMatches.length === 0 && p.flagMatches.length === 0) {
      p.setScrollMode(true);
      return;
    }
    if (key.pageUp) {
      p.setScrollOffset((prev) => Math.min(p.scrollback.length - 1, prev + 5));
      return;
    }
    if (key.pageDown) {
      p.setScrollOffset((prev) => Math.max(0, prev - 5));
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'd')) {
      p.exit();
      return;
    }
    if (key.ctrl && key.tab) {
      const routes: TuiRoute[] = ['home', 'session', 'workflow', 'mcp'];
      const nextIdx = (routes.indexOf(p.activeRoute) + 1) % routes.length;
      p.navigate(routes[nextIdx]);
      return;
    }
    if (key.meta) {
      if (input === '1') { p.navigate('home'); return; }
      if (input === '2') { p.navigate('session'); return; }
      if (input === '3') { p.navigate('workflow'); return; }
      if (input === '4') { p.navigate('mcp'); return; }
    }
    // Ctrl+L clears the visible scrollback (terminal-level) and the
    // in-memory entry list, leaving only the banner. Standard REPL UX
    // — when long sessions feel cluttered, the user can hard-reset the
    // viewport without restarting the CLI. The agent's conversation
    // history is unaffected; only the rendered scrollback resets.
    if (key.ctrl && input === 'l') {
      p.setScrollback((rows) => rows.filter((r) => r.kind === 'raw'));
      if (process.stdout.isTTY) {
        // \x1b[2J clears visible screen; \x1b[3J clears scrollback;
        // \x1b[H homes the cursor. Same sequence renderWithResizeClear
        // emits on resize.
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      }
      return;
    }
    if (key.shift && key.tab && p.onAccessModeCycle) {
      const next = p.onAccessModeCycle();
      if (next === 'read' || next === 'write' || next === 'shell') {
        p.setAccessMode(next);
        p.pushFns.notice(`Access mode → ${next}`);
      }
      return;
    }
    // @-mention navigation — takes precedence over slash palette since
    // they're mutually exclusive (slash starts the buffer; @ trails it).
    if (p.atMatches.length > 0) {
      if (key.upArrow) {
        p.setAtCursor((c) => (c - 1 + p.atMatches.length) % p.atMatches.length);
        return;
      }
      if (key.downArrow) {
        p.setAtCursor((c) => (c + 1) % p.atMatches.length);
        return;
      }
      if (key.tab && !key.shift) {
        const picked = p.atMatches[p.atCursor] ?? p.atMatches[0];
        p.setComposerProgrammatic(applyAtCompletion(p.composerValue, picked));
        p.setAtCursor(0);
        return;
      }
      if (key.escape) {
        p.setAtDismissed(true);
        return;
      }
    }
    // Palette navigation — only when palette is open AND there's at
    // least one match. We DON'T use `key.return` here because Enter is
    // handled by TextInput's onSubmit (which calls onComposerSubmit
    // above, which performs the highlight-substitution).
    if (p.slashQuery !== null && p.paletteMatches.length > 0) {
      if (key.upArrow) {
        p.setPaletteCursor((c) => (c - 1 + p.paletteMatches.length) % p.paletteMatches.length);
        return;
      }
      if (key.downArrow) {
        p.setPaletteCursor((c) => (c + 1) % p.paletteMatches.length);
        return;
      }
      if (key.tab && !key.shift) {
        // Tab autocompletes the highlighted command into the composer
        // (with a trailing space so the user can keep typing args). Uses the
        // programmatic setter so the cursor lands at the END (INPUT-ERGO).
        const picked = p.paletteMatches[p.paletteCursor] ?? p.paletteMatches[0];
        p.setComposerProgrammatic(picked.cmd + ' ');
        p.setPaletteCursor(0);
        return;
      }
    }
    // INPUT-ERGO — flag-suggestion palette (args mode, trailing `-token`).
    // ↑/↓ navigate, Tab completes the highlighted flag.
    if (p.flagMatches.length > 0) {
      if (key.upArrow) {
        p.setFlagCursor((c) => (c - 1 + p.flagMatches.length) % p.flagMatches.length);
        return;
      }
      if (key.downArrow) {
        p.setFlagCursor((c) => (c + 1) % p.flagMatches.length);
        return;
      }
      if (key.tab && !key.shift) {
        const picked = p.flagMatches[p.flagCursor] ?? p.flagMatches[0];
        p.setComposerProgrammatic(applyFlagCompletion(p.composerValue, picked.flag));
        p.setFlagCursor(0);
        return;
      }
    }
    // INPUT-ERGO — shell-style history recall. Only when NO palette owns the
    // arrow keys (slash / @ / flag all closed). ↑ older, ↓ newer; falling off
    // the new end restores the draft the user was typing.
    if (p.slashQuery === null && p.atMatches.length === 0 && p.flagMatches.length === 0) {
      if (key.upArrow) {
        if (p.histIndex === LIVE) p.setHistDraft(p.composerValue); // entering browse — stash the live draft
        const move = historyPrev(p.histEntries, p.histIndex);
        if (move.value !== null) {
          p.setHistIndex(move.index);
          p.setComposerProgrammatic(move.value);
        }
        return;
      }
      if (key.downArrow) {
        const move = historyNext(p.histEntries, p.histIndex, p.histDraft);
        if (move.value !== null || move.index === LIVE) {
          p.setHistIndex(move.index);
          if (move.value !== null) p.setComposerProgrammatic(move.value);
        }
        return;
      }
    }
  });
}
