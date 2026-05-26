import { format } from 'node:util';

export interface CapturedConsole<T> {
  result: T;
  output: string;
}

type ConsoleMethod = 'log' | 'warn' | 'error' | 'info';

/**
 * Legacy slash-command handlers still write through console.log/warn/error.
 * In the Ink chat shell, letting those writes escape makes Ink promote them
 * above the live frame, which visually places command output before the
 * BrainRouter banner. Capture the writes and replay them into scrollback.
 */
export async function captureConsoleOutput<T>(fn: () => Promise<T> | T): Promise<CapturedConsole<T>> {
  const originals: Record<ConsoleMethod, (...args: any[]) => void> = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  let output = '';
  const append = (...args: any[]) => {
    output += format(...args) + '\n';
  };

  console.log = append;
  console.warn = append;
  console.error = append;
  console.info = append;
  try {
    const result = await fn();
    return { result, output };
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    console.info = originals.info;
  }
}
