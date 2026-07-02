import { EventEmitter } from 'node:events';

// --- Readline shim ----------------------------------------------------

/**
 * Minimum-surface readline.Interface implementation that satisfies the
 * existing slash command handlers. The handlers were written assuming a
 * real readline — they call rl.prompt() / rl.write() / rl.pause() /
 * rl.close() / rl.on(...) at various points. Under the Ink REPL there
 * is no readline; we route the calls that have a sensible analog
 * (write → composer.setComposer, close → ink.exit) and no-op the rest.
 */
export interface ReadlineShimHooks {
  closeChat: () => void;
  onWriteToComposer: (text: string) => void;
  /** Register a one-shot callback for the next user submission (askYesNo). */
  waitForLine: (cb: (line: string) => void) => void;
}

export function createReadlineShim(hooks: ReadlineShimHooks): EventEmitter & {
  close: () => void;
  prompt: (preserveCursor?: boolean) => void;
  pause: () => any;
  resume: () => any;
  write: (text: string) => void;
  setPrompt: (text: string) => void;
  question: (q: string, cb: (line: string) => void) => void;
  line: string;
  cursor: number;
} {
  const emitter = new EventEmitter();
  const shim = emitter as any;
  shim.close = () => { hooks.closeChat(); };
  shim.prompt = (_preserveCursor?: boolean) => { /* no-op: composer is always shown */ };
  shim.pause = () => shim;
  shim.resume = () => shim;
  shim.write = (text: string) => { hooks.onWriteToComposer(text); };
  shim.setPrompt = (_text: string) => { /* no-op: prompt label is the footer pill */ };
  // Promise-shaped `question` for askYesNo: print the prompt text via
  // console.log (Ink's patchConsole bubbles it above the redraw region)
  // and stash the callback for the next submission.
  shim.question = (q: string, cb: (line: string) => void) => {
    process.stdout.write(q);
    hooks.waitForLine(cb);
  };
  shim.line = '';
  shim.cursor = 0;
  return shim;
}
