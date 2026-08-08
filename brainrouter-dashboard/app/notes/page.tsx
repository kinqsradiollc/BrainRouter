"use client";

/**
 * Notes — ADR-029 Part E on the web.
 *
 * The owner's standing rule is that a feature with a desktop UI has a dashboard
 * UI. Until now Notes had none, and the half that was missing is the half only
 * this surface can do: Q5 records that resolution had to become a SERVER
 * capability precisely because the dashboard has no local store, and a notes
 * mode that only exists where the files are is a notes mode you cannot read from
 * a machine with nothing checked out.
 *
 * **This is a reader, and that is a decision rather than an unfinished editor.**
 * E1's parity test is about the typing gesture — the slash menu, the input
 * rules, Enter splitting a block at the caret — and it is judged on the surface
 * where people write. A second editor would be two implementations of the
 * hardest part of this ADR, and the one that gets less use is the one that
 * quietly stops matching. What is here instead is everything a reader needs and
 * the desktop cannot give you from the web: the page tree, the page, the
 * references resolved live, "what links here", and E3's database views.
 *
 * Everything it reads comes from the same endpoints the sync path fills
 * (`/api/notes/pages`, `/api/notes/databases/:id`) and the same resolver every
 * other surface calls (`/api/workspace/resolve`). There is no dashboard-only
 * read path, because a second path is what B3 and C3 exist to prevent.
 *
 * **Part F is judged here by F1's rule, not by E4's table.** Being a reader
 * decides what this surface OFFERS; it does not excuse drawing a kind wrongly.
 * A table, an embed, a mirror and a database nested in a page each had a case in
 * this file's switch that did not exist, and every one of them rendered as a
 * plain line of text — F1's defect, committed on the surface Part F never
 * looked at. They are drawn now, and `notes-dashboard-renderers.test.ts` fails
 * if one of them loses its renderer again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import { authDownload, authFetch } from "../../lib/adminApi";
import { tableCells, tableWidth } from "./tableCells";
import styles from "./notes.module.css";

/* ------------------------------------------------------------------- types */

interface Stamp { physical: number; logical: number; deviceId: string }
interface Stamped<T> { value: T; at: Stamp }

interface NoteBlock {
  id: string;
  parentId: Stamped<string | null>;
  rank: Stamped<string>;
  kind: Stamped<string>;
  text: Stamped<string>;
  /** On a `table`, core's flag for "the first row is the header" (see markdown.ts). */
  checked?: Stamped<boolean>;
  level?: Stamped<number>;
  language?: Stamped<string>;
  icon?: Stamped<string>;
  cover?: Stamped<string>;
  collapsed?: Stamped<boolean>;
  /**
   * F3's remarks, which live ON the block rather than as child blocks — so they
   * arrive with the page read and a per-block thread costs no extra request.
   * Core's `comment.ts` records why: a child would be tombstoned with its
   * parent, and C5 says deleting a target never deletes the link.
   */
  comments?: Record<string, NoteComment>;
}

/** Migration 053's projection — a sidebar row without the page behind it. */
interface PageMeta {
  blockId: string;
  parentId: string | null;
  kind: string;
  rank: string;
  title: string;
  icon: string | null;
  cover: string | null;
  favourite: boolean;
}

interface DatabaseCell { property: { id: string; name: string; type: string }; display: string; unsupported: boolean }
interface DatabaseRow { id: string; title: string; icon: string | null; cover: string | null; cells: DatabaseCell[] }
interface DatabaseGroup { key: string | null; label: string; empty: boolean; rows: DatabaseRow[] }
interface DatabaseProjection {
  title: string;
  view: { id: string; name: string; kind: string };
  kind: string;
  columns: Array<{ id: string; name: string; type: string }>;
  rows: DatabaseRow[];
  groups: DatabaseGroup[];
  total: number;
  filteredOut: number;
  skipped: Array<{ kind: string; property: string; reason: string; detail: string }>;
  notices: string[];
}
/** F1 — which files this block can honestly be offered as. Decided by the server. */
type ExportFormat = "markdown" | "csv";

interface DatabaseView {
  projection: DatabaseProjection;
  views: Array<{ id: string; name: string; kind: string }>;
  rowsInDatabase: number;
  rowsRead: number;
  exportFormats: ExportFormat[];
}

interface PageRead {
  page: NoteBlock;
  blocks: NoteBlock[];
  truncated: boolean;
  exportFormats: ExportFormat[];
}

interface Backlink { fromBlockId: string; targetKey: string; citeCount: number; userId: string }

/**
 * A3/A4 — what `/api/workspace/resolve` answers, as the four outcomes core
 * models them. `line` is the SENTENCE the server already wrote for this
 * resolution (`renderWorkspaceResolution`), and the embed and the mirror below
 * render that rather than composing their own: A4's leak only has to happen on
 * one surface to have happened, and "an item you do not have access to" is the
 * wording every other surface shows.
 */
interface WorkspaceResolved {
  line: string;
  resolution: {
    status: "found" | "denied" | "gone" | "unavailable";
    ref?: { mode: string; kind: string; id: string } | null;
    /**
     * The mode's own current state. For a note block this is Q3's context —
     * the block, the headings above it and a count of the rest — so an embed of
     * a note can show where in its page the target sits.
     */
    target?: {
      label: string;
      state?: {
        headings?: string[];
        text?: string;
        omittedLabel?: string | null;
      };
    };
  };
}

/**
 * How many mirrors deep this reader draws before it stops and says so.
 *
 * Core's `MAX_SYNCED_DEPTH`. A mirror inside a mirrored subtree is legitimate,
 * so the bound is not one; it is small because past it a reader has lost track
 * of which document they are in. It also terminates the case core detects
 * separately — a mirror of an ancestor — which would otherwise draw itself
 * forever, and "it hung" is not a sentence anybody can act on.
 */
const MAX_SYNCED_DEPTH = 3;

/** F3 — one remark, as the server stores it. Body and author are UNTRUSTED text. */
interface NoteComment {
  id: string;
  body: Stamped<string>;
  author: string;
  createdAt: Stamp;
  resolved: Stamped<boolean>;
  /** A remark taken back. A tombstone, so a peer's older edit has something to lose against. */
  deletedAt?: Stamp;
}

interface CommentThread {
  blockId: string;
  comments: NoteComment[];
  /** C5 — the block went and the remarks did not. */
  blockDeleted: boolean;
  blockDeletedAt?: string;
}

const UNTITLED = "Untitled";

export default function NotesPage() {
  return (
    <AuthGuard>
      <Notes />
    </AuthGuard>
  );
}

function Notes() {
  // Every read is pinned to the ACTIVE org and refetches when it changes. A
  // dashboard page that reads without it answers from whichever org the server
  // defaults to, so switching organizations leaves the previous one's pages on
  // screen — a defect this dashboard has already shipped once, for providers.
  const { activeOrgId } = useActiveOrg();
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [favourites, setFavourites] = useState<PageMeta[]>([]);
  const [databases, setDatabases] = useState<PageMeta[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPages = useCallback(async () => {
    try {
      /**
       * Three projections, asked for rather than derived from the first.
       *
       * Filtering the page list here would be quicker and wrong twice over: the
       * favourites are ordered by rank on the server and a local filter shows
       * them in document order, and a favourite is ANY block — people pin lines,
       * not only pages — so half of them are not in the page list at all. The
       * desktop asks core the same two questions for the same reasons, and two
       * surfaces that answered them differently is what C3 exists to prevent.
       */
      const [body, pinned, dbs] = await Promise.all([
        authFetch<{ pages: PageMeta[] }>("/api/notes/pages", { orgId: activeOrgId }),
        authFetch<{ favourites: PageMeta[] }>("/api/notes/favourites", { orgId: activeOrgId }),
        authFetch<{ databases: PageMeta[] }>("/api/notes/databases", { orgId: activeOrgId }),
      ]);
      setPages(body.pages ?? []);
      setFavourites(pinned.favourites ?? []);
      setDatabases(dbs.databases ?? []);
      setError(null);
    } catch (e) {
      // The last good tree stays on screen. Blanking it because one refresh
      // failed loses what the person was reading for a condition that resolves
      // on its own.
      setError(e instanceof Error ? e.message : "Could not load your pages.");
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { setOpenId(null); setLoading(true); }, [activeOrgId]);
  useEffect(() => { void loadPages(); }, [loadPages]);

  /**
   * ADR-028 D2's rule, carried over: the surface reconciles on its own.
   *
   * No Sync button here either. A button asking you to press it makes staying
   * current YOUR job, and the moment you forget once the page you are reading is
   * quietly stale — worse than being visibly behind.
   */
  useEffect(() => {
    const tick = (): void => { if (!document.hidden) void loadPages(); };
    const timer = window.setInterval(tick, 30_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [loadPages]);

  const roots = useMemo(() => pages.filter((p) => !p.parentId || !pages.some((q) => q.blockId === p.parentId)), [pages]);
  const open = useMemo(() => pages.find((p) => p.blockId === openId) ?? null, [pages, openId]);

  /**
   * ADR-029 C1's fourth verb — the one write a reader needs.
   *
   * Marking what you want to come back to is what people do WHILE reading, and
   * it is the half of the sidebar this surface could otherwise show and never
   * change. It goes through `workspace/update` rather than a notes-specific
   * endpoint because that is what the shared verb is for: the mode that owns the
   * record decides what "favourite" means, the block's lease still fences the
   * write, and it merges like any other device's operation instead of winning by
   * being the server. It is not the editor — the typing gestures stay where E1
   * is judged.
   */
  /**
   * Where a favourite opens.
   *
   * E4's favourites are deliberately not restricted to pages — people pin lines
   * — and this surface reads PAGES. A pinned line opens the page it lives on,
   * which is where somebody would go to read it. When the chain above it is not
   * in the page list (a line nested under another line, which the projection has
   * no row for) the row still shows what was pinned and says where to open it,
   * rather than being a link that does nothing.
   */
  const pageFor = useCallback((row: PageMeta): string | null => {
    const known = new Map(pages.map((p) => [p.blockId, p] as const));
    if (known.has(row.blockId)) return row.blockId;
    const byId = new Map([...pages, ...favourites].map((p) => [p.blockId, p] as const));
    let cursor: string | null = row.parentId;
    // Bounded: two devices can reparent a pair of blocks into each other, and
    // the tree is repaired on the desktop rather than here.
    for (let hops = 0; cursor && hops < 12; hops += 1) {
      if (known.has(cursor)) return cursor;
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return null;
  }, [pages, favourites]);

  const setFavourite = useCallback(async (page: PageMeta, favourite: boolean) => {
    try {
      await authFetch("/api/workspace/update", {
        orgId: activeOrgId,
        method: "POST",
        body: { uri: `brainrouter://notes/block/${page.blockId}`, fields: { favourite } },
      });
      await loadPages();
    } catch (e) {
      // Named, because a refusal here is usually the block lease doing its job —
      // somebody is typing in that page on another device — and a star that
      // silently does not stick reads as the page being broken.
      setError(e instanceof Error ? e.message : "Could not change that.");
    }
  }, [activeOrgId, loadPages]);

  useEffect(() => {
    if (!openId && roots.length > 0) setOpenId(roots[0]!.blockId);
  }, [openId, roots]);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Notes"
        description="Your pages and databases, read from anywhere. The same notes the desktop app shows."
      />
      {error ? <div className={styles.error}>{error}</div> : null}

      {loading ? <InlineLoading /> : pages.length === 0 ? (
        <div className={styles.empty}>
          <strong>No pages yet</strong>
          <span>
            Pages you write in the desktop app appear here as soon as they sync — and everything they
            link to resolves from here too.
          </span>
        </div>
      ) : (
        <div className={styles.layout}>
          <nav className={styles.sidebar} aria-label="Pages">
            {favourites.length > 0 ? (
              <>
                <div className={styles.sectionLabel}>Favourites</div>
                {favourites.map((p) => {
                  const target = pageFor(p);
                  return (
                    <PageRow
                      key={`fav-${p.blockId}`}
                      page={p}
                      active={target !== null && target === openId}
                      onOpen={() => { if (target) setOpenId(target); }}
                      hint={target ? undefined : "This line is nested too deep to open from here."}
                    />
                  );
                })}
              </>
            ) : null}
            <div className={styles.sectionLabel}>Pages</div>
            <PageTree pages={pages} parentId={null} roots={roots} openId={openId} onOpen={setOpenId} depth={0} />
            {databases.length > 0 ? (
              <>
                {/* E3 — a database is a page you can open, and finding one in
                    the tree means remembering which page it was embedded in.
                    Core's list, so the titles are the decoded ones. */}
                <div className={styles.sectionLabel}>Databases</div>
                {databases.map((p) => (
                  <PageRow key={`db-${p.blockId}`} page={p} active={p.blockId === openId} onOpen={setOpenId} />
                ))}
              </>
            ) : null}
          </nav>

          <section className={styles.reader}>
            {open
              ? (
                <Reader
                  meta={open}
                  pages={pages}
                  onOpen={setOpenId}
                  orgId={activeOrgId}
                  favourite={favourites.some((p) => p.blockId === open.blockId) || open.favourite}
                  onFavourite={(next) => void setFavourite(open, next)}
                />
              )
              : <InlineLoading />}
          </section>
        </div>
      )}

      <p className={styles.footnote}>
        Reading, and the star. Pages are written in the desktop app, where the editor lives — everything
        here follows the same references and shows the same live state.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- the sidebar */

/** B4 — nesting is one recursion over the parent, so the tree is one function. */
function PageTree({ pages, parentId, roots, openId, onOpen, depth }: {
  pages: PageMeta[];
  parentId: string | null;
  roots: PageMeta[];
  openId: string | null;
  onOpen: (id: string) => void;
  depth: number;
}) {
  const children = parentId === null ? roots : pages.filter((p) => p.parentId === parentId);
  // A page nested twenty deep is a loop somebody made or a tree nobody reads.
  if (depth > 8) return null;
  return (
    <>
      {children.map((page) => (
        <div key={page.blockId}>
          <PageRow page={page} active={page.blockId === openId} onOpen={onOpen} depth={depth} />
          <PageTree pages={pages} parentId={page.blockId} roots={roots} openId={openId} onOpen={onOpen} depth={depth + 1} />
        </div>
      ))}
    </>
  );
}

function PageRow({ page, active, onOpen, depth = 0, hint }: {
  page: PageMeta; active: boolean; onOpen: (id: string) => void; depth?: number;
  /** Said on hover when the row cannot open here — never a link that does nothing. */
  hint?: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.pageRow}${active ? ` ${styles.pageRowActive}` : ""}`}
      style={depth > 0 ? { paddingLeft: 8 + depth * 12 } : undefined}
      title={hint}
      onClick={() => onOpen(page.blockId)}
    >
      <span className={styles.pageIcon}>{page.icon ?? (page.kind === "database" ? "▦" : "◻")}</span>
      <span className={styles.pageName}>{page.title || UNTITLED}</span>
      {page.kind === "database" ? <span className={styles.pageBadge}>db</span> : null}
    </button>
  );
}

/* ---------------------------------------------------------------- the page */

function Reader({ meta, pages, onOpen, orgId, favourite, onFavourite }: {
  meta: PageMeta;
  pages: PageMeta[];
  onOpen: (id: string) => void;
  orgId: string;
  favourite: boolean;
  onFavourite: (next: boolean) => void;
}) {
  const isDatabase = meta.kind === "database";
  const [page, setPage] = useState<PageRead | null>(null);
  const [database, setDatabase] = useState<DatabaseView | null>(null);
  const [viewId, setViewId] = useState<string | undefined>(undefined);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  /**
   * Bumped by a write made INSIDE the document — resolving a comment on a block.
   * The page read is the only thing that holds those remarks (they travel on the
   * block record), so re-reading it is how the block that changed catches up
   * without every block holding its own copy of the thread.
   */
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);

  useEffect(() => {
    setViewId(undefined); setPage(null); setDatabase(null); setExportNotice(null);
  }, [meta.blockId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (isDatabase) {
          const query = viewId ? `?view=${encodeURIComponent(viewId)}` : "";
          const body = await authFetch<DatabaseView>(
            `/api/notes/databases/${encodeURIComponent(meta.blockId)}${query}`, { orgId },
          );
          if (!cancelled) { setDatabase(body); setError(null); }
        } else {
          const body = await authFetch<PageRead>(
            `/api/notes/pages/${encodeURIComponent(meta.blockId)}`, { orgId },
          );
          if (!cancelled) { setPage(body); setError(null); }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not open that page.");
      }
    })();
    return () => { cancelled = true; };
  }, [meta.blockId, isDatabase, viewId, orgId, revision]);

  // A2 — "what links here" is a QUERY over content, never a stored back-edge, so
  // it is asked fresh for whatever page is open rather than carried with it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const uri = `brainrouter://notes/block/${meta.blockId}`;
        const body = await authFetch<{ backlinks: Backlink[] }>(
          `/api/notes/backlinks?target=${encodeURIComponent(uri)}`, { orgId },
        );
        if (!cancelled) setBacklinks(body.backlinks ?? []);
      } catch {
        // No backlinks is the normal answer; a failed query is not worth a
        // banner over the document somebody is reading.
        if (!cancelled) setBacklinks([]);
      }
    })();
    return () => { cancelled = true; };
  }, [meta.blockId, orgId]);

  const trail = useMemo(() => breadcrumb(pages, meta.blockId), [pages, meta.blockId]);
  // F1 — the formats come from the read that just happened, so this offers
  // exactly what core says the block can be written as and never CSV on a page.
  const exportFormats = (isDatabase ? database?.exportFormats : page?.exportFormats) ?? [];

  return (
    <>
      {meta.cover ? <img className={styles.cover} src={meta.cover} alt="" /> : null}
      <div className={styles.pageTitle}>
        {meta.icon ? <span>{meta.icon}</span> : null}
        <h2>{meta.title || UNTITLED}</h2>
        <button
          type="button"
          className={`${styles.star}${favourite ? ` ${styles.starOn}` : ""}`}
          aria-pressed={favourite}
          title={favourite ? "Remove from favourites" : "Add to favourites"}
          aria-label={favourite ? "Remove from favourites" : "Add to favourites"}
          onClick={() => onFavourite(!favourite)}
        >
          ★
        </button>
        <ExportTools
          blockId={meta.blockId}
          formats={exportFormats}
          viewId={isDatabase ? (database?.projection.view.id ?? viewId) : undefined}
          orgId={orgId}
          onNotice={setExportNotice}
        />
      </div>
      {trail.length > 1 ? (
        <div className={styles.breadcrumb}>{trail.map((p) => p.title || UNTITLED).join(" / ")}</div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}
      {exportNotice ? <div className={styles.notice}>{exportNotice}</div> : null}

      {isDatabase
        ? <DatabaseReader view={database} viewId={viewId} onView={setViewId} onOpen={onOpen} pages={pages} />
        : <PageBlocks page={page} onOpen={onOpen} pages={pages} orgId={orgId} reload={reload} revision={revision} />}

      {backlinks.length > 0 ? (
        <div className={styles.backlinks}>
          <div className={styles.sectionLabel}>What links here</div>
          {backlinks.map((link) => (
            <BacklinkRow key={link.fromBlockId} link={link} pages={pages} onOpen={onOpen} orgId={orgId} />
          ))}
        </div>
      ) : null}

      <PageComments blockId={meta.blockId} orgId={orgId} />
    </>
  );
}

/* ---------------------------------------------------- F3 · getting data out */

/**
 * ADR-029 F3 — "can I leave", as a button.
 *
 * The formats are the SERVER's answer (`exportFormats` on the page and database
 * reads, computed by core's `exportFormatsFor`), not a guess from the block's
 * kind. F1's rule is that nothing promises what it does not do, and a menu that
 * decided for itself would offer "Export as CSV" on a page of paragraphs — where
 * a one-column table of titles is not the page and there is no honest answer.
 *
 * The file is built by the server and saved from the bytes it sent. Rendering it
 * would be a second writer; downloading it is the whole feature.
 */
function ExportTools({ blockId, formats, viewId, orgId, onNotice }: {
  blockId: string; formats: ExportFormat[]; viewId?: string; orgId: string;
  /** Said by the READER, below the title: a sentence inside a flex row of
   *  buttons would be squeezed to nothing on the width it matters at. */
  onNotice: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = useCallback(async (format: ExportFormat) => {
    setBusy(format);
    onNotice(null);
    try {
      const query = new URLSearchParams({ format });
      // A database exports the VIEW that is on screen, which is what a person
      // means by "export this" — the rows they filtered and the order they set.
      if (format === "csv" && viewId) query.set("view", viewId);
      const file = await authDownload(
        `/api/notes/blocks/${encodeURIComponent(blockId)}/export?${query.toString()}`, { orgId },
      );
      saveFile(file.filename, file.contentType, file.content);
      // Stated, not implied. The Markdown carries the same sentence inside the
      // document; CSV has nowhere to put one that is not also a row, so the
      // server says it in a header and this is where it lands.
      if (file.truncated) {
        onNotice("That is longer than one file carries, so the download stops partway. The file says where.");
      }
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Could not build that file.");
    } finally {
      setBusy(null);
    }
  }, [blockId, viewId, orgId, onNotice]);

  if (formats.length === 0) return null;
  return (
    <div className={styles.pageTools}>
      {formats.map((format) => (
        <button
          key={format}
          type="button"
          className={styles.toolButton}
          disabled={busy !== null}
          title={format === "csv" ? "Download this view as a spreadsheet" : "Download this page as Markdown"}
          onClick={() => void run(format)}
        >
          {busy === format ? "…" : format === "csv" ? "CSV" : "Markdown"}
        </button>
      ))}
    </div>
  );
}

/** Save bytes the API already produced. No formatting decision happens here. */
function saveFile(filename: string, contentType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next turn of the loop rather than immediately: some browsers
  // start reading the object AFTER the click handler returns, and a URL revoked
  // synchronously gives them an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* --------------------------------------------------------- F3 · comments */

/**
 * ADR-029 F3 — comments on the open page, resolved and unresolved.
 *
 * The thread is read and written through `/api/notes/blocks/:id/comments`, and
 * the write goes the ordinary push path on the server (B3) — so a remark left
 * here merges with one left on the desktop instead of one of them winning by
 * arriving second.
 *
 * **Every string here is rendered as TEXT.** A comment can be typed by anybody a
 * page is shared with and can arrive over sync from another device, so it is
 * data: `{comment.body.value}` inside JSX is escaped by React, and nothing on
 * this path builds HTML or a URL out of it.
 */
/**
 * The two comment writes, in one place each.
 *
 * Both surfaces that leave a remark — the page thread below and the per-block
 * thread inside the document — call these rather than building the request
 * themselves, so neither can start sending a differently shaped body to the same
 * route. The route is the previous layer's; nothing here is a second write path.
 */
async function postComment(orgId: string, blockId: string, body: string): Promise<void> {
  await authFetch(`/api/notes/blocks/${encodeURIComponent(blockId)}/comments`, {
    orgId, method: "POST", body: { body },
  });
}

async function setCommentResolved(
  orgId: string, blockId: string, commentId: string, resolved: boolean,
): Promise<void> {
  await authFetch(
    `/api/notes/blocks/${encodeURIComponent(blockId)}/comments/${encodeURIComponent(commentId)}`,
    { orgId, method: "PATCH", body: { resolved } },
  );
}

/**
 * The remarks a block carries, oldest first.
 *
 * Ordered by the creation stamp rather than by key, which is what core's
 * `blockComments` does and for the reason it gives: a comment that arrives from
 * another device lands in whatever key order JSON gives it, and a thread whose
 * order depends on sync timing reads as a different conversation on two screens.
 */
function liveComments(block: NoteBlock): NoteComment[] {
  return Object.values(block.comments ?? {})
    .filter((comment) => !comment.deletedAt)
    .sort((a, b) =>
      a.createdAt.physical - b.createdAt.physical
      || a.createdAt.logical - b.createdAt.logical
      || a.id.localeCompare(b.id));
}

function PageComments({ blockId, orgId }: { blockId: string; orgId: string }) {
  const [thread, setThread] = useState<CommentThread | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setThread(await authFetch<CommentThread>(
        `/api/notes/blocks/${encodeURIComponent(blockId)}/comments`, { orgId },
      ));
    } catch {
      // No thread is the normal answer for most blocks; a failed read is not
      // worth a banner over the document somebody is reading.
      setThread(null);
    }
  }, [blockId, orgId]);

  useEffect(() => { setDraft(""); setError(null); void load(); }, [load]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await postComment(orgId, blockId, body);
      setDraft("");
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not leave that comment.");
    } finally {
      setBusy(false);
    }
  }, [blockId, draft, orgId, load]);

  const resolve = useCallback(async (comment: NoteComment) => {
    try {
      await setCommentResolved(orgId, blockId, comment.id, !comment.resolved.value);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change that.");
    }
  }, [blockId, orgId, load]);

  if (!thread) return null;
  return (
    <div className={styles.comments}>
      <div className={styles.sectionLabel}>Comments</div>
      {thread.blockDeleted ? (
        // C5 — deleting the target of a link never deletes the link, and saying
        // so is the difference between a stale thread and a thread about
        // something that is gone.
        <div className={styles.notice}>
          This page has been deleted. Its comments are kept — restore the page and they are back in place.
        </div>
      ) : null}
      {error ? <div className={styles.error}>{error}</div> : null}

      {thread.comments.map((comment) => (
        <div
          key={comment.id}
          className={`${styles.comment}${comment.resolved.value ? ` ${styles.commentDone}` : ""}`}
        >
          <div className={styles.commentHead}>
            <span className={styles.commentAuthor}>{comment.author}</span>
            <span>{new Date(comment.createdAt.physical).toLocaleString()}</span>
            <button type="button" className={styles.toolButton} onClick={() => void resolve(comment)}>
              {comment.resolved.value ? "Reopen" : "Resolve"}
            </button>
          </div>
          <div className={styles.commentBody}>{comment.body.value}</div>
        </div>
      ))}

      <div className={styles.commentForm}>
        <textarea
          className={styles.commentInput}
          value={draft}
          placeholder="Leave a comment on this page"
          aria-label="Leave a comment on this page"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" className={styles.toolButton} disabled={busy || !draft.trim()} onClick={() => void send()}>
          {busy ? "…" : "Comment"}
        </button>
      </div>
    </div>
  );
}

function breadcrumb(pages: PageMeta[], id: string): PageMeta[] {
  const trail: PageMeta[] = [];
  let cursor: string | null = id;
  // Bounded, because two devices can concurrently reparent a pair of pages into
  // each other and the tree builder repairs that on the desktop, not here.
  for (let hops = 0; cursor && hops < 12; hops += 1) {
    const found: PageMeta | undefined = pages.find((p) => p.blockId === cursor);
    if (!found) break;
    trail.unshift(found);
    cursor = found.parentId;
  }
  return trail;
}

function PageBlocks({ page, onOpen, pages, orgId, reload, revision }: {
  page: { page: NoteBlock; blocks: NoteBlock[]; truncated: boolean } | null;
  onOpen: (id: string) => void;
  pages: PageMeta[];
  orgId: string;
  reload: () => void;
  revision: number;
}) {
  if (!page) return <InlineLoading />;
  if (page.blocks.length === 0) {
    return <div className={styles.empty}><span>This page is empty.</span></div>;
  }
  return (
    <>
      {page.truncated ? (
        // Stated, not implied: a document that silently stops reads as a
        // document that ends there.
        <div className={styles.notice}>
          This page is long — only the first part is shown here. Open it in the desktop app to read all of it.
        </div>
      ) : null}
      <div className={styles.blocks}>
        {page.blocks.map((block) => (
          <Block
            key={block.id} block={block} onOpen={onOpen} pages={pages}
            orgId={orgId} reload={reload} revision={revision}
          />
        ))}
      </div>
    </>
  );
}

/** Everything a block needs to draw itself, carried as one prop bag because six
 *  of the renderers below need all of it and threading them apart obscured which
 *  ones actually reach the network. */
interface BlockContext {
  onOpen: (id: string) => void;
  pages: PageMeta[];
  orgId: string;
  reload: () => void;
  /**
   * The reader's revision counter, so a read made BELOW the page read catches up
   * with it. A table's rows and a mirror's source arrive from their own
   * requests; without this, resolving a comment on a mirrored line would refresh
   * the page around it and leave the line itself showing the old count.
   */
  revision: number;
  /** How many mirrors are already open above this block. See `MAX_SYNCED_DEPTH`. */
  depth?: number;
}

/**
 * ADR-029 F1 — every kind is drawn as that kind.
 *
 * This switch is the defect site Part F is named for, committed a second time on
 * this surface: `table`, `table-row`, `embed`, `synced` and a nested `database`
 * all fell through to `default:` and rendered as a plain line of text. A page
 * with a table in it showed a row of pipe-separated characters where the table
 * was. F1's rule is that an offer the product cannot honour is worse than an
 * absence, and a block the desktop draws as a grid is exactly such an offer.
 *
 * `paragraph` reaching `default:` is CORRECT and stays: a paragraph IS plain
 * text, and "fixing" it would frame prose in a box nobody asked for.
 *
 * `notes-dashboard-renderers.test.ts` enumerates core's `NOTE_BLOCK_KINDS` and
 * fails if any kind but that one loses its case here — the guard the desktop had
 * and this surface did not, which is why this gap survived Part F.
 */
function Block({ block, ...ctx }: { block: NoteBlock } & BlockContext) {
  return (
    <BlockShell block={block} orgId={ctx.orgId} reload={ctx.reload}>
      <BlockBody block={block} {...ctx} />
    </BlockShell>
  );
}

function BlockBody({ block, onOpen, pages, orgId, reload, revision, depth = 0 }: { block: NoteBlock } & BlockContext) {
  const kind = block.kind.value;
  const text = block.text.value;
  const body = <Inline text={text} onOpen={onOpen} pages={pages} orgId={orgId} />;

  switch (kind) {
    case "heading": {
      const level = block.level?.value ?? 1;
      const style = level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3;
      return <div className={`${styles.block} ${style}`}>{body}</div>;
    }
    case "bullet":
      return <div className={`${styles.block} ${styles.list}`}><span className={styles.bullet}>•</span><span>{body}</span></div>;
    case "numbered":
      // The number is a function of tree position and is computed by the
      // editor; a dashboard that invented one would disagree with the desktop
      // the moment a sibling was deleted elsewhere.
      return <div className={`${styles.block} ${styles.list}`}><span className={styles.bullet}>–</span><span>{body}</span></div>;
    case "todo":
      return (
        <div className={`${styles.block} ${styles.list}`}>
          <span className={styles.bullet}>{block.checked?.value ? "☑" : "☐"}</span>
          <span className={block.checked?.value ? styles.todoDone : undefined}>{body}</span>
        </div>
      );
    case "toggle":
      return <div className={`${styles.block} ${styles.list}`}><span className={styles.bullet}>▸</span><span>{body}</span></div>;
    case "quote":
      return <div className={`${styles.block} ${styles.quote}`}>{body}</div>;
    case "callout":
      return (
        <div className={styles.callout}>
          <span>{block.icon?.value ?? "◆"}</span>
          <div>{body}</div>
        </div>
      );
    case "code":
      return <pre className={styles.code}>{text}</pre>;
    case "divider":
      return <hr className={styles.divider} />;
    case "image":
      return <img className={styles.image} src={text} alt="" />;
    case "bookmark": {
      // Same allow-list as an inline link: a bookmark's text is a URL somebody
      // else may have written, and this surface is where it becomes an `href`.
      const href = safeHref(text);
      return (
        <div className={styles.block}>
          {href
            ? <a href={href} target="_blank" rel="noreferrer noopener">{text}</a>
            : <span className={styles.refPending}>{text}</span>}
        </div>
      );
    }
    case "page":
      return (
        <button type="button" className={`${styles.block} ${styles.ref}`} onClick={() => onOpen(block.id)}>
          {block.icon?.value ?? "◻"} {text || UNTITLED}
        </button>
      );
    case "table":
      return <TableBlock block={block} onOpen={onOpen} pages={pages} orgId={orgId} revision={revision} />;
    case "table-row":
      // A row reached on its own means its table is not the parent — a shape the
      // product does not make, and one core's Markdown writer also handles
      // rather than assumes away. Its cells are still cells, so it draws as a
      // one-row grid instead of as the pipe-separated characters it is stored as.
      return <TableGrid rows={[block]} header={false} onOpen={onOpen} pages={pages} orgId={orgId} />;
    case "embed":
      return <EmbedBlock uri={text} onOpen={onOpen} pages={pages} orgId={orgId} />;
    case "synced":
      return (
        <SyncedBlock
          uri={text} onOpen={onOpen} pages={pages} orgId={orgId}
          reload={reload} revision={revision} depth={depth}
        />
      );
    case "database":
      // E3's views, from the SAME server-computed projection the top-level
      // database read uses. A second projection here would be a second view
      // language, and the symptom is one board showing different cards on two
      // screens with nothing to say which is right.
      return <NestedDatabase blockId={block.id} title={text} onOpen={onOpen} pages={pages} orgId={orgId} />;
    default:
      return <div className={styles.block}>{body}</div>;
  }
}

/* ------------------------------------------------- F3 · comments on a block */

/**
 * The thread that belongs to THIS block, drawn where the block is.
 *
 * The remarks come from the page read — they travel on the block record (core's
 * `comment.ts`), so a document with forty commented lines costs no requests at
 * all. A block with nothing on it renders exactly as before; the shell is a
 * no-op rather than an always-present affordance, because a marker on every line
 * is chrome over somebody's writing.
 */
function BlockShell({ block, orgId, reload, children }: {
  block: NoteBlock; orgId: string; reload: () => void; children: React.ReactNode;
}) {
  const comments = liveComments(block);
  if (comments.length === 0) return <>{children}</>;
  return (
    <div className={styles.commented}>
      {children}
      <BlockComments blockId={block.id} comments={comments} orgId={orgId} reload={reload} />
    </div>
  );
}

/**
 * F3's "resolved and unresolved", on one block.
 *
 * **Every string here renders as TEXT.** A comment is typed by a person, arrives
 * over sync from another device, and can say anything at all — including
 * something that looks like markup or like an instruction. `{comment.body.value}`
 * inside JSX is escaped by React, and nothing on this path builds HTML, a URL or
 * a prop out of it. That is C4's rule (content is data, never instructions)
 * applied to the one field on a page that a stranger can write.
 */
function BlockComments({ blockId, comments, orgId, reload }: {
  blockId: string; comments: NoteComment[]; orgId: string; reload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresolved = comments.filter((comment) => !comment.resolved.value);

  const act = useCallback(async (run: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await run();
      setError(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : failure);
    } finally {
      setBusy(false);
    }
  }, [reload]);

  return (
    <div className={styles.blockComments}>
      <button
        type="button"
        className={`${styles.commentPill}${unresolved.length > 0 ? ` ${styles.commentPillOpen}` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {unresolved.length > 0
          ? `${unresolved.length} open comment${unresolved.length === 1 ? "" : "s"}`
          : `${comments.length} resolved comment${comments.length === 1 ? "" : "s"}`}
      </button>

      {open ? (
        <div className={styles.blockThread}>
          {error ? <div className={styles.error}>{error}</div> : null}
          {comments.map((comment) => (
            <div
              key={comment.id}
              className={`${styles.comment}${comment.resolved.value ? ` ${styles.commentDone}` : ""}`}
            >
              <div className={styles.commentHead}>
                <span className={styles.commentAuthor}>{comment.author}</span>
                <span>{new Date(comment.createdAt.physical).toLocaleString()}</span>
                <button
                  type="button"
                  className={styles.toolButton}
                  disabled={busy}
                  onClick={() => void act(
                    () => setCommentResolved(orgId, blockId, comment.id, !comment.resolved.value),
                    "Could not change that.",
                  )}
                >
                  {comment.resolved.value ? "Reopen" : "Resolve"}
                </button>
              </div>
              <div className={styles.commentBody}>{comment.body.value}</div>
            </div>
          ))}

          <div className={styles.commentForm}>
            <textarea
              className={styles.commentInput}
              value={draft}
              placeholder="Reply on this block"
              aria-label="Reply on this block"
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="button"
              className={styles.toolButton}
              disabled={busy || !draft.trim()}
              onClick={() => void act(async () => {
                await postComment(orgId, blockId, draft.trim());
                setDraft("");
              }, "Could not leave that comment.")}
            >
              {busy ? "…" : "Reply"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ F3 · the table */

/**
 * ADR-029 E4 — a table, drawn as a grid.
 *
 * A table's rows are its CHILDREN, and `/api/notes/pages/:id` returns direct
 * children only — so a table on a page arrives with no rows and the grid has to
 * ask for them. One request per table on the page, made only when a table is
 * actually present, rather than widening every page read for a block kind most
 * pages do not contain.
 *
 * The read is the ordinary page route, so it is scoped to `(org_id, user_id)`
 * exactly like the read that produced the table block itself. Nothing here
 * fetches "just the block".
 */
function TableBlock({ block, onOpen, pages, orgId, revision }: { block: NoteBlock } & Omit<BlockContext, "reload" | "depth">) {
  const children = useChildBlocks(block.id, orgId, revision);

  if (children.status === "loading") return <InlineLoading />;
  if (children.status === "error") {
    return <div className={styles.notice}>This table&rsquo;s rows could not be loaded. {children.detail}</div>;
  }
  // A table's children are its rows. Anything else under one is a tree the
  // product does not produce, and drawing it as a row would garble both.
  const rows = children.blocks.filter((row) => row.kind.value === "table-row");
  if (rows.length === 0) {
    return <div className={`${styles.block} ${styles.refPending}`}>An empty table.</div>;
  }
  return (
    <>
      {/* Core's own rule, not a guess: the Markdown writer treats `checked` on
          the TABLE block as "the first row is the header", so the two surfaces
          cannot disagree about which row is the heading of a column. */}
      <TableGrid
        rows={rows}
        header={block.checked?.value === true}
        onOpen={onOpen}
        pages={pages}
        orgId={orgId}
      />
      {children.truncated ? (
        <div className={styles.notice}>
          This table is longer than is shown here. Open it in the desktop app to read all of it.
        </div>
      ) : null}
    </>
  );
}

function TableGrid({ rows, header, onOpen, pages, orgId }: {
  rows: NoteBlock[]; header: boolean;
} & Omit<BlockContext, "reload" | "depth" | "revision">) {
  const width = tableWidth(rows.map((row) => row.text.value));
  const headRow = header ? rows[0] : undefined;
  const bodyRows = headRow ? rows.slice(1) : rows;

  const cellsOf = (row: NoteBlock): string[] => tableCells(row.text.value, width);

  return (
    // The database view's own frame and rules, with `grid` relaxing the two that
    // are wrong for a note's table: a cell here holds a person's prose rather
    // than a projected property, so it wraps, and its header is their words
    // rather than a column name and is not shouted in capitals.
    <div className={styles.tableWrap}>
      <table className={`${styles.table} ${styles.grid}`}>
        {headRow ? (
          <thead>
            <tr>
              {cellsOf(headRow).map((cell, at) => (
                // Positional keys: a cell has no identity of its own — the row is
                // the record, and its cells are one encoded string.
                <th key={at}>{cell}</th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {bodyRows.map((row) => (
            <tr key={row.id}>
              {cellsOf(row).map((cell, at) => (
                <td key={at}>
                  {/* Through `Inline`, so a reference typed into a cell resolves
                      live (A3) instead of showing as a raw `brainrouter://` URI. */}
                  <Inline text={cell} onOpen={onOpen} pages={pages} orgId={orgId} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------- A3 · embeds and mirrors */

/**
 * ADR-029 A3 — an embed shows its target's CURRENT state.
 *
 * Resolved through `/api/workspace/resolve`, which is the same resolver the
 * desktop and the CLI call and the only one that is permission-aware (A4). The
 * three ways "current" can fail — gone, denied, unavailable — each render as
 * their own SENTENCE, and the sentence is the server's
 * (`renderWorkspaceResolution`) rather than one written here: A4's rule that a
 * denied reference must not leak its title is a property of the product, and six
 * surfaces each writing their own refusal is six chances for one of them to
 * write the title instead.
 */
function EmbedBlock({ uri, onOpen, pages, orgId }: { uri: string } & Omit<BlockContext, "reload" | "depth" | "revision">) {
  const trimmed = uri.trim();
  const resolved = useResolution(trimmed, orgId);
  const local = localPageFor(trimmed, pages);

  if (!trimmed) {
    // Not routed through the resolver: an embed nobody has pointed anywhere yet
    // would come back "a link that is not a valid reference", which describes a
    // broken link rather than an empty slot and sends the reader looking for a
    // fault that is not there.
    return <div className={`${styles.embed} ${styles.refPending}`}>An embed with no target chosen yet.</div>;
  }
  if (!resolved) return <div className={`${styles.embed} ${styles.refPending}`}>Resolving…</div>;

  const found = resolved.resolution.status === "found";
  const state = resolved.resolution.target?.state;
  return (
    <div className={styles.embed}>
      <div className={styles.embedHead}>
        <span className={styles.embedLabel}>Embed</span>
        {found && local ? (
          <button type="button" className={styles.toolButton} onClick={() => onOpen(local)}>Open</button>
        ) : null}
      </div>
      {/* The label for a target you may see; core's sentence for every other
          outcome. Both arrive as one string, so this cannot accidentally render
          a title in the case A4 forbids one. */}
      <div className={found ? styles.embedTitle : styles.refPending}>{resolved.line}</div>
      {found && state?.headings && state.headings.length > 0 ? (
        // Q3's heading ancestry — a block with a place in its page rather than a
        // sentence floating on its own.
        <div className={styles.embedTrail}>{state.headings.join(" / ")}</div>
      ) : null}
      {found && state?.text ? (
        <div className={styles.embedBody}>
          <Inline text={state.text} onOpen={onOpen} pages={pages} orgId={orgId} />
        </div>
      ) : null}
      {found && state?.omittedLabel ? (
        <div className={styles.embedTrail}>{state.omittedLabel}</div>
      ) : null}
    </div>
  );
}

/**
 * ADR-029 F3 — one block, many places, one truth.
 *
 * A mirror stores an ADDRESS and never the words, so this draws the SOURCE's
 * own blocks: the row a reader sees under a mirror carries the source block's
 * id, which is what makes "editing either place edits the one block" true on the
 * surface that can edit rather than a claim this reader has to maintain.
 *
 * The frame says whose words these are, because the one thing a mirror must not
 * look like is a copy — a reader who thinks they are editing a local paragraph
 * is about to change somebody else's page.
 *
 * **Resolution comes first, and the content second.** The resolver decides
 * whether this viewer may see the source (A4); only then does the source's own
 * page read run, and that read is scoped to `(org_id, user_id)` like every other
 * one here. A source that resolves but is not in this person's own corpus — a
 * block somebody else shared — renders as its resolved label and says the rest
 * is elsewhere, which is smaller than it could be and never a leak.
 */
function SyncedBlock({ uri, onOpen, pages, orgId, reload, revision, depth = 0 }: { uri: string } & BlockContext) {
  const trimmed = uri.trim();
  const tooDeep = depth >= MAX_SYNCED_DEPTH;
  const resolved = useResolution(tooDeep ? "" : trimmed, orgId);
  const sourceId = resolved?.resolution.status === "found"
    && resolved.resolution.ref?.mode === "notes"
    && resolved.resolution.ref.kind === "block"
    ? resolved.resolution.ref.id
    : null;
  const source = useChildBlocks(sourceId, orgId, revision);

  if (!trimmed) {
    return <div className={`${styles.synced} ${styles.refPending}`}>A synced block with no source chosen yet.</div>;
  }
  if (tooDeep) {
    // A bound rather than a cycle check, and it covers both: a mirror of an
    // ancestor is a page that would draw itself forever, and "it hung" is not a
    // sentence anybody can act on.
    return (
      <div className={`${styles.synced} ${styles.refPending}`}>
        This synced block is nested deeper than this page draws. Open its source to read it.
      </div>
    );
  }
  if (!resolved) return <div className={`${styles.synced} ${styles.refPending}`}>Resolving…</div>;

  const found = resolved.resolution.status === "found";
  const openable = sourceId && pages.some((p) => p.blockId === sourceId) ? sourceId : null;

  return (
    <div className={styles.synced}>
      <div className={styles.syncedHead}>
        <span className={styles.embedLabel}>Synced — the same block, shown here and at its source</span>
        {openable ? (
          <button type="button" className={styles.toolButton} onClick={() => onOpen(openable)}>Open source</button>
        ) : null}
      </div>

      {!found ? (
        // A3/A4/C5 — gone, denied and unavailable, each in core's own words.
        <div className={`${styles.block} ${styles.refPending}`}>{resolved.line}</div>
      ) : !sourceId ? (
        // Found, and not a note block. A mirror of a planner item is a sentence
        // that leads somewhere, rather than a block id that does not exist.
        <>
          <div className={styles.block}>{resolved.line}</div>
          <div className={styles.embedTrail}>A synced block mirrors a note block; this points somewhere else.</div>
        </>
      ) : source.status === "loading" ? (
        <InlineLoading />
      ) : source.status === "error" ? (
        // Resolved, so the label is one this viewer is allowed to see; the words
        // live in a partition this read does not cross.
        <>
          <div className={styles.block}>{resolved.line}</div>
          <div className={styles.embedTrail}>Kept somewhere this page cannot read from. Open the source to see it.</div>
        </>
      ) : (
        <>
          <Block
            block={source.root} onOpen={onOpen} pages={pages} orgId={orgId}
            reload={reload} revision={revision} depth={depth + 1}
          />
          {source.blocks.map((child) => (
            <Block
              key={child.id} block={child} onOpen={onOpen} pages={pages} orgId={orgId}
              reload={reload} revision={revision} depth={depth + 1}
            />
          ))}
          {source.truncated ? (
            <div className={styles.embedTrail}>Only the first part of the source is shown here.</div>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------- E3 · a database inside a page */

/**
 * A database block on a page, through the SAME read and the same views as one
 * opened from the sidebar.
 *
 * `DatabaseReader` and `/api/notes/databases/:id` are reused rather than
 * reimplemented: every projection decision — which rows the filter kept, how
 * they sort, which bucket each lands in — is made by core's `projectDatabase` on
 * the server, and a nested copy that decided any of it here would be the second
 * view language E3 exists to refuse.
 */
function NestedDatabase({ blockId, title, onOpen, pages, orgId }: {
  blockId: string; title: string;
} & Omit<BlockContext, "reload" | "depth" | "revision">) {
  const [view, setView] = useState<DatabaseView | null>(null);
  const [viewId, setViewId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const query = viewId ? `?view=${encodeURIComponent(viewId)}` : "";
        const body = await authFetch<DatabaseView>(
          `/api/notes/databases/${encodeURIComponent(blockId)}${query}`, { orgId },
        );
        if (!cancelled) { setView(body); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not open this database.");
      }
    })();
    return () => { cancelled = true; };
  }, [blockId, viewId, orgId]);

  return (
    <div className={styles.nestedDatabase}>
      <div className={styles.nestedHead}>
        <span className={styles.pageIcon}>▦</span>
        <span className={styles.nestedTitle}>{view?.projection.title || title || UNTITLED}</span>
        {/* F3's "can I leave", offered here too, and offered from the SERVER's
            list of formats — so a database nested in a page and one opened on
            its own cannot disagree about what it can be written as. */}
        <ExportTools
          blockId={blockId}
          formats={view?.exportFormats ?? []}
          viewId={view?.projection.view.id ?? viewId}
          orgId={orgId}
          onNotice={setNotice}
        />
      </div>
      {error ? <div className={styles.error}>{error}</div> : null}
      {notice ? <div className={styles.notice}>{notice}</div> : null}
      <DatabaseReader view={view} viewId={viewId} onView={setViewId} onOpen={onOpen} pages={pages} />
    </div>
  );
}

/* ----------------------------------------------------------- shared reads */

type ChildBlocks =
  | { status: "loading" }
  | { status: "error"; detail: string }
  | { status: "ready"; root: NoteBlock; blocks: NoteBlock[]; truncated: boolean };

/**
 * One block and its direct children, through the page route.
 *
 * The route reads any live block, which B4 makes correct rather than a
 * shortcut — a page is a block that has children, so "the children of this
 * table" and "the blocks of this page" are one question. Passing `null` skips
 * the request entirely, which is what lets a caller resolve first and read
 * second without a hook it cannot call conditionally.
 */
function useChildBlocks(blockId: string | null, orgId: string, revision: number): ChildBlocks {
  const [state, setState] = useState<ChildBlocks>({ status: "loading" });

  useEffect(() => {
    if (!blockId) { setState({ status: "loading" }); return; }
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const body = await authFetch<PageRead>(
          `/api/notes/pages/${encodeURIComponent(blockId)}`, { orgId },
        );
        if (!cancelled) {
          setState({ status: "ready", root: body.page, blocks: body.blocks ?? [], truncated: body.truncated });
        }
      } catch (e) {
        if (!cancelled) setState({ status: "error", detail: e instanceof Error ? e.message : "" });
      }
    })();
    return () => { cancelled = true; };
  }, [blockId, orgId, revision]);

  return state;
}

/**
 * One reference, resolved live (A3). `null` while the answer is still coming.
 *
 * Every outcome is a 200 from the resolver — denied, gone and unavailable are
 * ANSWERS a document renders inline, not errors to retry — so a throw here means
 * the request itself failed, and the caller falls back to saying nothing it does
 * not know. Passing an empty URI skips the request.
 */
function useResolution(uri: string, orgId: string): WorkspaceResolved | null {
  const [resolved, setResolved] = useState<WorkspaceResolved | null>(null);

  useEffect(() => {
    if (!uri) { setResolved(null); return; }
    let cancelled = false;
    setResolved(null);
    void (async () => {
      try {
        const body = await authFetch<WorkspaceResolved>(
          `/api/workspace/resolve?uri=${encodeURIComponent(uri)}`, { orgId },
        );
        if (!cancelled) setResolved(body);
      } catch {
        // The URI is what the document says, and inventing a label for a target
        // we could not reach would be the quietly-wrong render A3 refuses.
        if (!cancelled) {
          setResolved({ line: uri, resolution: { status: "unavailable", ref: null } });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [uri, orgId]);

  return resolved;
}

const NOTE_BLOCK_URI = "brainrouter://notes/block/";

/** The page id a note-block URI opens to here, when this reader has that page. */
function localPageFor(uri: string, pages: PageMeta[]): string | null {
  if (!uri.startsWith(NOTE_BLOCK_URI)) return null;
  const id = uri.slice(NOTE_BLOCK_URI.length);
  return pages.some((p) => p.blockId === id) ? id : null;
}

/* -------------------------------------------------------------- inline text */

/**
 * E2's stored marks, read back for display.
 *
 * A deliberate READER rather than a second parser: it renders the subset E2
 * names and leaves anything it does not recognise as the characters that are
 * there. That asymmetry is the whole reason this is acceptable where a second
 * MERGE would not be — the cost of a mark this misses is a visible asterisk on
 * one surface, and the cost of a merge rule that differed is a sentence nobody
 * wrote. If it starts to matter, the fix is core exporting a browser-safe
 * parser, not this growing.
 *
 * References are the part that is not cosmetic. A3 requires a reference to
 * render LIVE, so each one becomes a chip that resolves through the same
 * `/api/workspace/resolve` every other surface calls — never a copy of the
 * target's title taken when the note was written.
 */
const REF_PATTERN = /brainrouter:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/g;
const MARK_PATTERN = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

function Inline({ text, onOpen, pages, orgId }: {
  text: string; onOpen: (id: string) => void; pages: PageMeta[]; orgId: string;
}) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(REF_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(<Marked key={`t${key++}`} text={text.slice(cursor, start)} />);
    parts.push(<ReferenceChip key={`r${key++}`} uri={match[0]} onOpen={onOpen} pages={pages} orgId={orgId} />);
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push(<Marked key={`t${key++}`} text={text.slice(cursor)} />);
  return <>{parts}</>;
}

/**
 * A link a note carries, or nothing.
 *
 * C4's rule reaches the DOM here. A note's text arrives over sync, is pasted
 * from a webpage or is written by anybody a page is shared with, so a `[label]`
 * whose target is `javascript:` is somebody else's script running in this
 * person's session the moment they click a paragraph. The scheme is allow-listed
 * rather than pattern-blocked, because a blocklist has to be right about every
 * scheme that exists and an allow-list only about the three that are useful.
 *
 * A refused link renders as its LABEL — the words are still the document's, and
 * dropping them would leave a sentence with a hole in it.
 */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  // Relative and anchor targets carry no scheme and cannot execute.
  if (href.startsWith("/") || href.startsWith("#")) return href;
  const scheme = href.slice(0, href.indexOf(":")).toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? href : null;
}

function Marked({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(MARK_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const token = match[0];
    if (token.startsWith("**")) parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("~~")) parts.push(<s key={key++}>{token.slice(2, -2)}</s>);
    else if (token.startsWith("`")) parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("*")) parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    else {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      parts.push(href
        ? <a key={key++} href={href} target="_blank" rel="noreferrer noopener">{label}</a>
        : <span key={key++}>{label}</span>);
    }
    cursor = start + token.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * A3 — the reference's CURRENT state, resolved, never a snapshot.
 *
 * The line comes from `renderWorkspaceResolution` on the server, so "an item you
 * do not have access to" and "planner item (deleted 4 Aug)" are written once for
 * the whole product rather than once per surface. A4's leak only has to happen
 * on one surface to have happened.
 */
function ReferenceChip({ uri, onOpen, pages, orgId }: {
  uri: string; onOpen: (id: string) => void; pages: PageMeta[]; orgId: string;
}) {
  const [line, setLine] = useState<string | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const body = await authFetch<{ line: string }>(
          `/api/workspace/describe?uri=${encodeURIComponent(uri)}`, { orgId },
        );
        if (!cancelled) setLine(body.line);
      } catch {
        // The URI itself is the honest fallback: it is what the document says,
        // and inventing a label for a target we could not reach would be the
        // quietly-wrong render A3 refuses.
        if (!cancelled) setLine(null);
      }
    })();
    return () => { cancelled = true; };
  }, [uri, orgId]);

  const localPage = uri.startsWith("brainrouter://notes/block/")
    ? pages.find((p) => p.blockId === uri.slice("brainrouter://notes/block/".length))
    : undefined;

  return (
    <button
      type="button"
      className={`${styles.ref}${line === null ? ` ${styles.refPending}` : ""}`}
      title={uri}
      onClick={() => { if (localPage) onOpen(localPage.blockId); }}
    >
      {line ?? uri}
    </button>
  );
}

function BacklinkRow({ link, pages, onOpen, orgId }: {
  link: Backlink; pages: PageMeta[]; onOpen: (id: string) => void; orgId: string;
}) {
  const [line, setLine] = useState<string>(link.fromBlockId);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const uri = `brainrouter://notes/block/${link.fromBlockId}`;
        const body = await authFetch<{ line: string }>(
          `/api/workspace/describe?uri=${encodeURIComponent(uri)}`, { orgId },
        );
        if (!cancelled) setLine(body.line);
      } catch {
        if (!cancelled) setLine(link.fromBlockId);
      }
    })();
    return () => { cancelled = true; };
  }, [link.fromBlockId, orgId]);

  const page = pages.find((p) => p.blockId === link.fromBlockId);
  return (
    <button type="button" className={styles.backlinkRow} onClick={() => { if (page) onOpen(page.blockId); }}>
      {line}
      {link.citeCount > 1 ? ` · ${link.citeCount} mentions` : ""}
    </button>
  );
}

/* ------------------------------------------------------- E3 · the databases */

/**
 * A database, through one of its views.
 *
 * Every projection decision — which rows the filter kept, how they sort, which
 * bucket each one lands in — was made by `projectDatabase` in core on the
 * server. This renders the answer. Re-deciding any of it here would be a second
 * view language, and the symptom is the same board showing different cards on
 * two screens with nothing to say which is right.
 */
function DatabaseReader({ view, viewId, onView, onOpen, pages }: {
  view: DatabaseView | null;
  viewId: string | undefined;
  onView: (id: string) => void;
  onOpen: (id: string) => void;
  pages: PageMeta[];
}) {
  if (!view) return <InlineLoading />;
  const { projection } = view;

  return (
    <>
      {view.views.length > 1 ? (
        <div className={styles.viewTabs}>
          {view.views.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`${styles.viewTab}${(viewId ?? projection.view.id) === v.id ? ` ${styles.viewTabActive}` : ""}`}
              onClick={() => onView(v.id)}
            >
              {v.name}
            </button>
          ))}
        </div>
      ) : null}

      {projection.notices.map((notice) => (
        <div key={notice} className={styles.notice}>{notice}</div>
      ))}
      {projection.skipped.length > 0 ? (
        // Reported, never silently resolved either way: a filter this build
        // could not apply changes which rows you are looking at.
        <div className={styles.notice}>
          {projection.skipped.length} rule{projection.skipped.length === 1 ? "" : "s"} could not be applied here:{" "}
          {projection.skipped.map((s) => s.detail).join("; ")}
        </div>
      ) : null}
      {view.rowsRead < view.rowsInDatabase ? (
        <div className={styles.notice}>
          Showing {view.rowsRead} of {view.rowsInDatabase} rows. Filters and sorts here ran over the rows
          that were read, so a row past that point is not shown even if it would have matched.
        </div>
      ) : null}

      {projection.kind === "board" || projection.kind === "calendar"
        ? <Board groups={projection.groups} onOpen={onOpen} pages={pages} />
        : projection.kind === "gallery" || projection.kind === "list"
          ? <Gallery rows={projection.rows} kind={projection.kind} onOpen={onOpen} pages={pages} />
          : <Table columns={projection.columns} rows={projection.rows} onOpen={onOpen} pages={pages} />}
    </>
  );
}

function openRow(rows: PageMeta[], id: string, onOpen: (id: string) => void): void {
  // A row IS a page (E3), so opening one is the same navigation as opening any
  // other page — there is no row detail view to build.
  if (rows.some((p) => p.blockId === id)) onOpen(id);
}

function Table({ columns, rows, onOpen, pages }: {
  columns: Array<{ id: string; name: string }>; rows: DatabaseRow[]; onOpen: (id: string) => void; pages: PageMeta[];
}) {
  if (rows.length === 0) return <div className={styles.empty}><span>No rows in this view.</span></div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Name</th>
            {columns.filter((c) => c.id !== "title").map((c) => <th key={c.id}>{c.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <button type="button" className={styles.rowTitle} onClick={() => openRow(pages, row.id, onOpen)}>
                  {row.icon ? `${row.icon} ` : ""}{row.title}
                </button>
              </td>
              {row.cells.filter((cell) => cell.property.id !== "title").map((cell) => (
                <td key={cell.property.id} title={cell.display}>
                  {cell.unsupported ? <span className={styles.refPending}>{cell.display}</span> : cell.display}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Board({ groups, onOpen, pages }: { groups: DatabaseGroup[]; onOpen: (id: string) => void; pages: PageMeta[] }) {
  return (
    <div className={styles.board}>
      {groups.map((group) => (
        <div key={group.key ?? "__none"} className={styles.boardColumn}>
          <div className={styles.boardHead}>
            <span>{group.label}</span>
            <span>{group.rows.length}</span>
          </div>
          {group.rows.map((row) => <Card key={row.id} row={row} onOpen={onOpen} pages={pages} />)}
        </div>
      ))}
    </div>
  );
}

function Gallery({ rows, kind, onOpen, pages }: {
  rows: DatabaseRow[]; kind: string; onOpen: (id: string) => void; pages: PageMeta[];
}) {
  if (rows.length === 0) return <div className={styles.empty}><span>No rows in this view.</span></div>;
  return (
    <div className={kind === "gallery" ? styles.gallery : styles.blocks}>
      {rows.map((row) => <Card key={row.id} row={row} onOpen={onOpen} pages={pages} />)}
    </div>
  );
}

function Card({ row, onOpen, pages }: { row: DatabaseRow; onOpen: (id: string) => void; pages: PageMeta[] }) {
  const cells = row.cells.filter((cell) => cell.property.id !== "title" && cell.display);
  return (
    <div className={styles.card}>
      <button type="button" className={styles.rowTitle} onClick={() => openRow(pages, row.id, onOpen)}>
        {row.icon ? `${row.icon} ` : ""}{row.title}
      </button>
      {cells.length > 0 ? (
        <div className={styles.cardCells}>
          {cells.map((cell) => `${cell.property.name}: ${cell.display}`).join(" · ")}
        </div>
      ) : null}
    </div>
  );
}
