/**
 * PREFIX-DRIFT (0.4.5) — explain WHY the immutable prefix cache missed.
 *
 * The prefix fingerprint (contextRegions.ts) tells you *that* the prefix
 * changed; it doesn't say *what* changed. A drift snapshot captures the prefix
 * at component granularity — system prompt, the tool name list, and the pinned
 * memory anchors — so two snapshots can be diffed into a human-readable cause
 * (e.g. "+2/-1 tools, anchors changed"). Pure + structurally typed so it has no
 * dependency on the ImmutablePrefix class and is trivially testable.
 */

export interface PrefixComponents {
  system: string;
  /** Tool names, in prefix order (order matters for the cache key). */
  toolNames: string[];
  /** Stable per-anchor identifiers (content is fine — anchors are short). */
  anchors: string[];
}

export interface PrefixSnapshot {
  systemLen: number;
  systemHash: string;
  toolNames: string[];
  anchorCount: number;
  anchorHash: string;
}

/** Cheap, stable 32-bit hash (FNV-1a) — enough to detect content drift. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function snapshotPrefix(c: PrefixComponents): PrefixSnapshot {
  return {
    systemLen: c.system.length,
    systemHash: shortHash(c.system),
    toolNames: [...c.toolNames],
    anchorCount: c.anchors.length,
    anchorHash: shortHash(c.anchors.join("\x00")),
  };
}

export interface PrefixDrift {
  changed: boolean;
  systemChanged: boolean;
  addedTools: string[];
  removedTools: string[];
  anchorsChanged: boolean;
  anchorDelta: number;
  /** One-line human cause, or "no change". */
  label: string;
}

/** Diff two prefix snapshots into a structured + labelled cause. */
export function diffPrefixSnapshots(prev: PrefixSnapshot, next: PrefixSnapshot): PrefixDrift {
  const prevTools = new Set(prev.toolNames);
  const nextTools = new Set(next.toolNames);
  const addedTools = next.toolNames.filter((t) => !prevTools.has(t));
  const removedTools = prev.toolNames.filter((t) => !nextTools.has(t));
  const systemChanged = prev.systemHash !== next.systemHash;
  const anchorsChanged = prev.anchorHash !== next.anchorHash;
  const anchorDelta = next.anchorCount - prev.anchorCount;

  const parts: string[] = [];
  if (systemChanged) parts.push("system changed");
  if (addedTools.length || removedTools.length) parts.push(`+${addedTools.length}/-${removedTools.length} tools`);
  if (anchorsChanged) parts.push(anchorDelta === 0 ? "anchors changed" : `anchors ${anchorDelta > 0 ? "+" : ""}${anchorDelta}`);

  const changed = parts.length > 0;
  return {
    changed,
    systemChanged,
    addedTools,
    removedTools,
    anchorsChanged,
    anchorDelta,
    label: changed ? parts.join(", ") : "no change",
  };
}
