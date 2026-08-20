// ADR-041 A41-13 (W1) — the spill store: a bounded, disk-backed cold tier for the
// in-memory ResultCache. When a large offloaded result is evicted (LRU) or expires
// (TTL) from the hot in-memory cache, its full text is spilled here instead of
// being lost, so a later `extract_result` can still recover it rather than seeing
// "not found or expired". The store is bounded (a max-file cap; oldest spill files
// are dropped first) so it cannot grow without limit, and refs are sanitized to a
// safe filename shape so a spill can never escape its directory.
import fs from 'node:fs';
import path from 'node:path';

/** Only the offload ref shape (`r-<hex>` / alphanumerics, dash, underscore) — never a path. */
function safeName(ref: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,128}$/.test(ref) ? `${ref}.spill` : undefined;
}

export class SpillStore {
  private ready = false;
  constructor(
    private readonly dir: string,
    private readonly maxFiles = 256,
  ) {}

  private ensureDir(): boolean {
    if (this.ready) return true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.ready = true;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  /** Spill a value to disk under `ref`. Best-effort — a failed write is swallowed. */
  spill(ref: string, text: string): void {
    const name = safeName(ref);
    if (!name || !this.ensureDir()) return;
    try {
      fs.writeFileSync(path.join(this.dir, name), text, 'utf8');
      this.enforceCap();
    } catch {
      /* best-effort cold tier — losing a spill is no worse than not having one */
    }
  }

  /** Retrieve a spilled value, or undefined if it was never spilled / already dropped. */
  retrieve(ref: string): string | undefined {
    const name = safeName(ref);
    if (!name) return undefined;
    try {
      return fs.readFileSync(path.join(this.dir, name), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Drop a spilled value (it was promoted back to the hot tier, or is truly gone). */
  drop(ref: string): void {
    const name = safeName(ref);
    if (!name) return;
    try {
      fs.rmSync(path.join(this.dir, name), { force: true });
    } catch {
      /* already gone */
    }
  }

  /** Keep the store bounded: when over the cap, delete the oldest spill files. */
  private enforceCap(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.spill'));
    } catch {
      return;
    }
    if (files.length <= this.maxFiles) return;
    const byAge = files
      .map((f) => {
        const full = path.join(this.dir, f);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return { full, mtime: 0 }; }
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const { full } of byAge.slice(0, files.length - this.maxFiles)) {
      try { fs.rmSync(full, { force: true }); } catch { /* raced */ }
    }
  }
}
