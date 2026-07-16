/**
 * The driver stdio line-protocol — newline-delimited JSON between the command
 * layer's client and the headed Playwright driver child. One JSON object per
 * line; the decoder buffers partial chunks and is CRLF-safe (Windows pipes can
 * deliver `\r\n`), per the project's CRLF hygiene rule.
 */
import type { Command } from '../types.js';

export interface DriverRequest {
  reqId: string;
  cmd: Command;
}

export interface DriverReply {
  reqId: string;
  /** The raw command result (validated by `normalizeResult` on the client side). */
  result?: unknown;
  /** A transport/driver-level error (rejects the pending request). */
  error?: string;
}

/** Frame one object as a single protocol line. */
export function encodeLine(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

/**
 * Reassemble complete JSON objects from a stream of (possibly partial) string
 * chunks. Trailing `\r` is stripped; blank and non-JSON lines (stray logs) are
 * skipped rather than thrown, so a noisy child can't wedge the protocol.
 */
export class LineDecoder {
  private buf = '';

  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      line = line.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Non-JSON noise on the channel — ignore.
      }
    }
    return out;
  }
}
