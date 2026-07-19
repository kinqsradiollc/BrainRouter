/**
 * The Backend seam (Layer 5) — the single boundary between the named command
 * layer and whatever actually drives the UI. Production embedded-browser
 * control uses BrowserControlPort instead of this legacy manifest command seam;
 * DriverClient remains an explicit test adapter only. A backend takes a
 * `Command` and returns the RAW reply validated by `normalize.ts`.
 */
import type { Command } from '../types.js';

export interface Backend {
  /** Execute one command; resolves with the raw driver reply (validated later). */
  perform(cmd: Command): Promise<unknown>;
  /** Release resources (close the browser / kill the driver child). */
  close?(): Promise<void>;
}

/** Safe production default: never launches Playwright or another browser. */
export class UnavailableBackend implements Backend {
  async perform(cmd: Command): Promise<unknown> {
    throw new Error(`in-app browser backend unavailable for ${cmd.kind}`);
  }
}

/** A canned backend for tests — records calls and returns a passing result. */
export class StubBackend implements Backend {
  readonly calls: Command[] = [];
  constructor(private readonly responder?: (cmd: Command) => unknown) {}

  async perform(cmd: Command): Promise<unknown> {
    this.calls.push(cmd);
    if (this.responder) return this.responder(cmd);
    return {
      ok: true,
      status: 'ok',
      command: cmd.kind,
      testID: (cmd as { testID?: string }).testID,
      screen: (cmd as { screen?: string }).screen,
      durationMs: 1,
      artifacts: { screenshots: [], videos: [], logs: [], other: [] },
    };
  }
}
