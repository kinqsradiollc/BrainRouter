/**
 * ADR-027 D10 (P7-2 remainder, P7-3) — table survival, readiness, tab lifecycle.
 *
 * D10 names three gaps the reference implementation has. URL absolutization is
 * already handled in the artifact builder; this closes the other two, plus the
 * lifecycle rule.
 *
 *   - TABLES MUST SURVIVE, and D10 calls this "the most common defect". A table
 *     flattened into prose does not read as damaged — it reads as a paragraph
 *     of numbers, which the model will happily reason over and get wrong. The
 *     loss is silent, and it destroys precisely the content people cite.
 *
 *   - READINESS. Our reads are programmatic rather than user-triggered, so
 *     nobody is looking at the page deciding it has loaded. Capturing early
 *     yields a spinner, an empty shell, or a cookie wall — stored as an
 *     artifact and cited later as though it were the page.
 *
 *   - TAB LIFECYCLE. Open, read, close. Leaked tabs accumulate until the
 *     browser is unusable, and each one holds a live renderer.
 */

/** A table as an extractor hands it over, before markdown conversion. */
export interface ExtractedTable {
  /** Header cells. Empty when the table has no header row. */
  header: readonly string[];
  rows: readonly (readonly string[])[];
}

/**
 * Render a table as GitHub-flavoured markdown.
 *
 * Ragged rows are PADDED rather than dropped. Real HTML tables use colspan and
 * omit trailing cells constantly; dropping a short row loses data, and dropping
 * the table loses more. A cell that is genuinely absent renders empty, which is
 * honest — the reader sees a gap rather than a silently shifted column.
 */
export function tableToMarkdown(table: ExtractedTable): string {
  const width = Math.max(
    table.header.length,
    ...table.rows.map((row) => row.length),
    0,
  );
  if (width === 0) return '';

  const pad = (row: readonly string[]): string[] =>
    Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? ''));

  // A table with no header still needs a header row to be valid markdown;
  // an empty one keeps the columns aligned without inventing labels.
  const header = table.header.length > 0 ? pad(table.header) : Array.from({ length: width }, () => '');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...table.rows.map((row) => `| ${pad(row).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Escape what would otherwise break the row structure. */
function escapeCell(value: string): string {
  return value
    .replace(/\|/g, '\\|')      // a raw pipe splits the row
    .replace(/\r?\n/g, '<br>')  // a newline ends the row entirely
    .trim();
}

/** Signals a capture layer can observe about page readiness. */
export interface ReadinessSignals {
  /** The document reached a terminal ready state. */
  documentComplete: boolean;
  /** Characters of visible text currently in the main content. */
  visibleTextLength: number;
  /** Network requests still outstanding. */
  pendingRequests: number;
  /** A consent/cookie interstitial is covering the content. */
  consentWallPresent?: boolean;
  /** Milliseconds spent waiting so far. */
  elapsedMs: number;
}

export type ReadinessVerdict =
  | { ready: true }
  | { ready: false; reason: string; retry: boolean };

export interface ReadinessOptions {
  /** Text below this is treated as an empty shell. */
  minTextLength?: number;
  /** Give up waiting after this. */
  timeoutMs?: number;
}

/**
 * Decide whether a page is worth capturing.
 *
 * Capturing early is worse than capturing late: a spinner stored as an artifact
 * gets cited later as though it were the page, and nothing downstream can tell
 * it apart from a genuinely empty article.
 *
 * A consent wall is NOT retried — waiting does not dismiss it, and capturing it
 * stores a cookie banner under the article's title.
 */
export function assessReadiness(
  signals: ReadinessSignals,
  options: ReadinessOptions = {},
): ReadinessVerdict {
  const minText = options.minTextLength ?? 200;
  const timeout = options.timeoutMs ?? 15_000;

  if (signals.consentWallPresent) {
    return { ready: false, reason: 'A consent interstitial is covering the content.', retry: false };
  }
  if (signals.elapsedMs >= timeout) {
    // Report rather than capture. An artifact from a timed-out load is a
    // fragment that will be cited as a whole.
    return { ready: false, reason: `Page did not become readable within ${timeout}ms.`, retry: false };
  }
  if (!signals.documentComplete) {
    return { ready: false, reason: 'Document is still loading.', retry: true };
  }
  if (signals.pendingRequests > 0) {
    return { ready: false, reason: `${signals.pendingRequests} request(s) still outstanding.`, retry: true };
  }
  if (signals.visibleTextLength < minText) {
    // Complete, quiet, and nearly empty is the client-rendered case: the shell
    // arrived and the content has not.
    return { ready: false, reason: 'Document is complete but nearly empty; content may still be rendering.', retry: true };
  }
  return { ready: true };
}

/** What a tab is for, which decides whether it may be reused or must close. */
export type TabPurpose =
  /** One-shot read. Closed as soon as the artifact is built. */
  | 'read'
  /** The visible research tab the user watches. Reused, never auto-closed. */
  | 'research'
  /** Opened by a tool for interaction. Closed when its task ends. */
  | 'task';

export interface OpenTab {
  id: string;
  purpose: TabPurpose;
  /** Whether the work that opened it has finished. */
  taskComplete: boolean;
  openedAtMs: number;
}

export interface TabLifecyclePlan {
  close: readonly string[];
  keep: readonly { id: string; reason: string }[];
}

/**
 * Decide which tabs to close.
 *
 * Explicit rather than a reaper on a timer: a tab closed because it got old,
 * while its task is still running, destroys work the agent is mid-way through.
 * Age only decides among tabs that are ALREADY finished.
 */
export function planTabLifecycle(
  tabs: readonly OpenTab[],
  options: { nowMs: number; maxIdleMs?: number } = { nowMs: 0 },
): TabLifecyclePlan {
  const maxIdle = options.maxIdleMs ?? 5 * 60_000;
  const close: string[] = [];
  const keep: { id: string; reason: string }[] = [];

  for (const tab of tabs) {
    if (tab.purpose === 'research') {
      // The user is watching this one. Closing it mid-session is jarring and
      // loses the navigation history they were following.
      keep.push({ id: tab.id, reason: 'Visible research tab.' });
      continue;
    }
    if (!tab.taskComplete) {
      keep.push({ id: tab.id, reason: 'Its task is still running.' });
      continue;
    }
    if (tab.purpose === 'read') { close.push(tab.id); continue; }
    // A finished task tab may linger briefly so a follow-up can reuse it.
    if (options.nowMs - tab.openedAtMs >= maxIdle) close.push(tab.id);
    else keep.push({ id: tab.id, reason: 'Recently finished; may be reused.' });
  }
  return { close, keep };
}
