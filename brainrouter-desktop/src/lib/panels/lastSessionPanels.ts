/**
 * ADR-028 G2 — the previous session's tab list, and how a saved one is read.
 *
 * Split out of `usePanels` so it can be exercised without pulling the panel
 * barrel (and its stylesheet imports) into a test. Deep-imports the panel
 * catalog for the same reason.
 */
import { PANEL_DEFS, type PanelId } from '../../panels/panelCatalog.js';

const VALID_IDS = new Set<PanelId>(PANEL_DEFS.map((panel) => panel.id));

// Persisted layouts can carry renamed/retired panel ids. The Markdown writing
// experience ('write' → 'docs') folded into the Editor, so both map to 'editor'.
// The Browser panel's internal id was renamed 'uitest' → 'browser', so a persisted
// open-tab layout survives the rename. Unknown ids are dropped, and duplicates are
// collapsed, so an upgrade never leaves a dead or doubled tab.
// ADR-028 G5 — `review` and `ci` fold into the one Pull request panel. They
// answered facets of a single question — can this land, and if not what is
// stopping it — and `ci` was already titled "PR / Checks", so four tabs meant
// assembling the real answer yourself from three of them.
//
// These two are here for PERSISTED layouts only. They are not members of
// `PanelId`, so no live call site can reach them: a caller that wants the
// consolidated panel has to say `stack` and gets a panel that renders. An
// alias that also caught live callers is how `ReviewPanel` became unreachable
// while the chooser still offered a "Review" button badged with the findings
// it was not going to show.
const PANEL_ID_ALIASES: Record<string, PanelId> = {
  write: 'editor', docs: 'editor', uitest: 'browser',
  review: 'stack', ci: 'stack',
};

export const migratePanelId = (id: string): PanelId => (PANEL_ID_ALIASES[id] ?? id) as PanelId;

export const migratePanelIds = (ids: unknown[]): PanelId[] => {
  const seen = new Set<PanelId>();
  return ids
    .map((p) => migratePanelId(String(p)))
    .filter((p) => VALID_IDS.has(p) && !seen.has(p) && (seen.add(p), true));
};

/** Where the previous session's tabs are recorded — never read at startup (G2). */
export const LAST_SESSION_PANELS_KEY = 'br-side-tabs-last';

/** The previous session's tab list, read before this session starts writing over it. */
export function readLastSessionPanels(): PanelId[] {
  try {
    const saved = localStorage.getItem(LAST_SESSION_PANELS_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved) as unknown;
    return Array.isArray(parsed) ? migratePanelIds(parsed) : [];
  } catch {
    // A malformed record means there is nothing to restore, which is a no-op
    // rather than an error worth showing.
    return [];
  }
}
