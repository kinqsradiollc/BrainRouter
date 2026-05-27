/**
 * Storm breaker — suppress identical (name, args) repeats (0.3.9 item 11.4).
 *
 * Model loops show up as the same tool call issued 3+ times in a row
 * with identical arguments. Without intervention, we burn tokens and
 * rate-limit headroom while the model thrashes.
 *
 * Adapted from openSrc/DeepSeek-Reasonix/src/repair/storm.ts.
 *
 * Subtleties:
 *
 *   - Mutating calls (`write_file`, `edit_file`, `run_command --apply`)
 *     CLEAR prior read-only entries. A post-edit verify-read after a
 *     write isn't a "repeat" — file state just changed.
 *   - Three identical edits in a row IS still a storm; mutating calls
 *     count amongst themselves.
 *   - Storm-exempt calls (`get_status`, `list_jobs`) are never
 *     suppressed — they're cheap state inspection.
 *
 * The default window is 6 calls / threshold 3 (suppress at the 3rd
 * identical inside the last 6). Tunable via `BRAINROUTER_STORM_*`
 * env vars in case a workload genuinely wants more headroom.
 */

export interface ToolCallLike {
  function: { name: string; arguments: string | object };
}

export type IsMutating = (call: ToolCallLike) => boolean;
export type IsStormExempt = (call: ToolCallLike) => boolean;

interface RecentEntry {
  name: string;
  args: string;
  readOnly: boolean;
}

export interface StormVerdict {
  suppress: boolean;
  reason?: string;
}

export class StormBreaker {
  private readonly windowSize: number;
  private readonly threshold: number;
  private readonly isMutating: IsMutating | undefined;
  private readonly isStormExempt: IsStormExempt | undefined;
  private readonly recent: RecentEntry[] = [];

  constructor(
    windowSize = 6,
    threshold = 3,
    isMutating?: IsMutating,
    isStormExempt?: IsStormExempt,
  ) {
    this.windowSize = windowSize;
    this.threshold = threshold;
    this.isMutating = isMutating;
    this.isStormExempt = isStormExempt;
  }

  /**
   * Inspect a candidate call. Returns `{ suppress: true, reason }`
   * when the call is the Nth identical inside the window; otherwise
   * records the call and returns `{ suppress: false }`.
   */
  inspect(call: ToolCallLike): StormVerdict {
    const name = call.function?.name;
    if (!name) return { suppress: false };
    if (this.isStormExempt?.(call)) return { suppress: false };

    const args = stableArgsString(call.function?.arguments);
    const mutating = this.isMutating ? this.isMutating(call) : false;
    const readOnly = !mutating;

    if (mutating) {
      // Drop prior read-only entries — file/shell state has just
      // changed, so a verify-read after this is allowed without
      // hitting the repeat counter.
      for (let i = this.recent.length - 1; i >= 0; i--) {
        if (this.recent[i]!.readOnly) this.recent.splice(i, 1);
      }
    }

    const count = this.recent.reduce(
      (n, e) => (e.name === name && e.args === args ? n + 1 : n),
      0,
    );
    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        reason: `${name} called with identical args ${count + 1} times — repeat-loop guard tripped`,
      };
    }
    this.recent.push({ name, args, readOnly });
    while (this.recent.length > this.windowSize) this.recent.shift();
    return { suppress: false };
  }

  /** Clear the window. Called at the start of every fresh user turn. */
  reset(): void {
    this.recent.length = 0;
  }

  get windowLength(): number {
    return this.recent.length;
  }
}

function stableArgsString(args: string | object | undefined): string {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') {
    try {
      return JSON.stringify(args, Object.keys(args as Record<string, unknown>).sort());
    } catch {
      return String(args);
    }
  }
  return '';
}
