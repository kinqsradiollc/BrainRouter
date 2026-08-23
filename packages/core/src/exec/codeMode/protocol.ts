/**
 * ADR-041 A41-15 (W3) — Code Mode control-plane protocol.
 *
 * The parent and the `run_code` child speak newline-delimited JSON over an
 * inherited control fd (fd 3), leaving the child's real stdout/stderr free for
 * the program's own output. One message per line; each line is one complete JSON
 * value. Framing mirrors the hosted-CLI stdio reader (`runtime/backends/hostedCli.ts`).
 */

/** child → parent: the program called `agent.<tool>(args)`; awaits a Result. */
export interface CallMessage {
  t: 'call';
  /** Correlation id chosen by the child. */
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

/** parent → child: the settled outcome of a Call. */
export interface ResultMessage {
  t: 'result';
  id: number;
  ok: boolean;
  /** Tool output string when ok; error message when not. */
  value: string;
}

/** child → parent: liveness beat (the dead-man's-switch input). */
export interface HeartbeatMessage {
  t: 'heartbeat';
  /** Cumulative event-loop-active ms the child has self-sampled (compute-meter refinement). */
  activeMs: number;
}

/** child → parent: the program returned; `result` is its (stringified) return value. */
export interface DoneMessage {
  t: 'done';
  result: string;
}

/** child → parent: the program threw before returning. */
export interface ErrorMessage {
  t: 'error';
  message: string;
}

/** Anything the child can send up the control fd. */
export type ChildMessage = CallMessage | HeartbeatMessage | DoneMessage | ErrorMessage;
/** Anything the parent can send down the control fd. */
export type ParentMessage = ResultMessage;

/** Encode one message as a single NDJSON line (trailing newline included). */
export function encodeLine(message: ChildMessage | ParentMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Stateful newline framer: feed it raw chunks, get back complete parsed messages.
 * A trailing partial line is buffered until its newline arrives. Malformed lines
 * are dropped (returned in `dropped`) rather than throwing — a hostile child must
 * never crash the parent framer.
 */
export function createLineFramer<T>() {
  let buffer = '';
  return {
    push(chunk: string): { messages: T[]; dropped: number } {
      buffer += chunk;
      const messages: T[] = [];
      let dropped = 0;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            messages.push(JSON.parse(line) as T);
          } catch {
            dropped++;
          }
        }
        nl = buffer.indexOf('\n');
      }
      return { messages, dropped };
    },
  };
}
