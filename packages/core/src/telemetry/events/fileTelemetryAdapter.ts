import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from '../../storage/store.js';
import { isTelemetryEvent, type TelemetryEvent } from './contracts.js';
import type { TelemetrySink } from './telemetryPort.js';

/**
 * Local-first JSONL telemetry sink. One event per line under
 * `~/.brainrouter/telemetry/events.jsonl` (override with `opts.filePath`).
 * Append-only with a soft cap: once the file drifts past ~20% over `cap`
 * lines it is rewritten down to the last `cap` lines. ALL filesystem I/O is
 * wrapped in try/catch so a record/list/clear can never throw into a caller —
 * telemetry must never break the CLI.
 *
 * Never writes message/file content or secrets — see `contracts.ts`.
 */
export function createFileTelemetrySink(opts?: { filePath?: string; cap?: number }): TelemetrySink {
  const filePath = opts?.filePath ?? path.join(getBrainrouterHome(), 'telemetry', 'events.jsonl');
  const cap = opts?.cap && opts.cap > 0 ? Math.floor(opts.cap) : 5_000;
  // Rewrite the file down to `cap` lines only once it exceeds this margin, so
  // we amortize the (relatively expensive) read+truncate over many cheap
  // appends instead of compacting on every single record.
  const compactThreshold = Math.floor(cap * 1.2);

  function ensureDir(): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function readLines(): string[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return [];
    return raw.split('\n').filter((line) => line.trim().length > 0);
  }

  function compactIfNeeded(): void {
    try {
      const lines = readLines();
      if (lines.length <= compactThreshold) return;
      const kept = lines.slice(-cap);
      ensureDir();
      // Write to a temp sibling then rename so a crash mid-compaction can't
      // leave a half-written events file.
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, `${kept.join('\n')}\n`, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      // best-effort compaction — leave the file as-is on any failure.
    }
  }

  return {
    record(event: TelemetryEvent): void {
      try {
        ensureDir();
        fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
        compactIfNeeded();
      } catch {
        // swallow — telemetry is strictly best-effort.
      }
    },

    list(limit?: number): TelemetryEvent[] {
      try {
        const lines = readLines();
        const events: TelemetryEvent[] = [];
        for (const line of lines) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (isTelemetryEvent(parsed)) events.push(parsed);
          } catch {
            // skip a single corrupt/partial line without failing the read.
          }
        }
        if (limit !== undefined && limit >= 0) return events.slice(-limit);
        return events;
      } catch {
        return [];
      }
    },

    clear(): void {
      try {
        if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      } catch {
        // best-effort — ignore.
      }
    },
  };
}
