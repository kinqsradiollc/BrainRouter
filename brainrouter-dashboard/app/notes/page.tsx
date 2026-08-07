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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import { authFetch } from "../../lib/adminApi";
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
  checked?: Stamped<boolean>;
  level?: Stamped<number>;
  language?: Stamped<string>;
  icon?: Stamped<string>;
  cover?: Stamped<string>;
  collapsed?: Stamped<boolean>;
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
interface DatabaseView {
  projection: DatabaseProjection;
  views: Array<{ id: string; name: string; kind: string }>;
  rowsInDatabase: number;
  rowsRead: number;
}

interface Backlink { fromBlockId: string; targetKey: string; citeCount: number; userId: string }

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
  const [page, setPage] = useState<{ page: NoteBlock; blocks: NoteBlock[]; truncated: boolean } | null>(null);
  const [database, setDatabase] = useState<DatabaseView | null>(null);
  const [viewId, setViewId] = useState<string | undefined>(undefined);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setViewId(undefined); setPage(null); setDatabase(null); }, [meta.blockId]);

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
          const body = await authFetch<{ page: NoteBlock; blocks: NoteBlock[]; truncated: boolean }>(
            `/api/notes/pages/${encodeURIComponent(meta.blockId)}`, { orgId },
          );
          if (!cancelled) { setPage(body); setError(null); }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not open that page.");
      }
    })();
    return () => { cancelled = true; };
  }, [meta.blockId, isDatabase, viewId, orgId]);

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
      </div>
      {trail.length > 1 ? (
        <div className={styles.breadcrumb}>{trail.map((p) => p.title || UNTITLED).join(" / ")}</div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}

      {isDatabase
        ? <DatabaseReader view={database} viewId={viewId} onView={setViewId} onOpen={onOpen} pages={pages} />
        : <PageBlocks page={page} onOpen={onOpen} pages={pages} orgId={orgId} />}

      {backlinks.length > 0 ? (
        <div className={styles.backlinks}>
          <div className={styles.sectionLabel}>What links here</div>
          {backlinks.map((link) => (
            <BacklinkRow key={link.fromBlockId} link={link} pages={pages} onOpen={onOpen} orgId={orgId} />
          ))}
        </div>
      ) : null}
    </>
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

function PageBlocks({ page, onOpen, pages, orgId }: {
  page: { page: NoteBlock; blocks: NoteBlock[]; truncated: boolean } | null;
  onOpen: (id: string) => void;
  pages: PageMeta[];
  orgId: string;
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
          <Block key={block.id} block={block} onOpen={onOpen} pages={pages} orgId={orgId} />
        ))}
      </div>
    </>
  );
}

function Block({ block, onOpen, pages, orgId }: {
  block: NoteBlock; onOpen: (id: string) => void; pages: PageMeta[]; orgId: string;
}) {
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
    case "bookmark":
      return <div className={styles.block}><a href={text} target="_blank" rel="noreferrer noopener">{text}</a></div>;
    case "page":
      return (
        <button type="button" className={`${styles.block} ${styles.ref}`} onClick={() => onOpen(block.id)}>
          {block.icon?.value ?? "◻"} {text || UNTITLED}
        </button>
      );
    default:
      return <div className={styles.block}>{body}</div>;
  }
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
      const href = token.slice(split + 2, -1);
      parts.push(<a key={key++} href={href} target="_blank" rel="noreferrer noopener">{label}</a>);
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
