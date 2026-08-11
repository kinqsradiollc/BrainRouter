"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  NOTE_BLOCK_KINDS,
  NOTE_PROPERTY_TYPES,
  applyInputRule,
  blockLinkUri,
  containerParents,
  defaultTableHeader,
  emptyTableRow,
  mentionCandidates,
  newPageIntent,
  noteBlockUri,
  plannerItemUri,
  searchSlashCatalog,
  selectedPageOrTop,
  withAncestorsExpanded,
  workItemUri,
  NEW_TABLE_COLUMNS,
  type BlockOpOutcome,
  type CodeSymbolPick,
  type DatabaseHostOps,
  type DatabaseReadDto,
  type FavouriteRow,
  type InputRuleTransformDto,
  type MentionCandidate,
  type MentionSources,
  type NoteBlock,
  type NoteBlockView,
  type NoteSendTarget,
  type NotesEditingCapabilities,
  type NotesHostCapabilities,
  type NotesMutationOperation,
  type NotesOps,
  type NotesShellState,
  type NoteTreeRepairView,
  type OrphanedThreadDto,
  type PropertyCatalogDto,
  type QuickFindHit,
  type RollupTargetsDto,
  type SaveViewInput,
  type SyncedReadDto,
  type TemplateRowDto,
  type TrashEntryDto,
  type WorkspaceResolutionDto,
} from "@kinqs/brainrouter-ui/notes";

import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import {
  authDownload,
  authFetch,
  type DashboardRequestError,
} from "../../lib/adminApi";
import {
  favouriteRows,
  mutationDisposition,
  notesLeaseGrant,
  notesMutationRequest,
  notesMutationResponse,
  projectDatabase,
  projectNotes,
  projectSynced,
  propertyCatalog,
  type DatabaseProjectionResponse,
  type MutationDisposition,
} from "./notesAdapter";

const POLL_MS = 5_000;
const LEASE_RENEW_MS = 10_000;
const TEXT_COMMIT_MS = 160;
const SEARCH_MS = 150;
const MENTION_TTL_MS = 15_000;
const DEVICE_STORAGE_KEY = "brainrouter:dashboard-notes-device";

type BlockUpdatePatch = Extract<NotesMutationOperation, { type: "block.update" }>["patch"];
type BlockKind = NonNullable<Extract<NotesMutationOperation, { type: "block.create" }>["input"]["kind"]>;
type PropertyType = Extract<NotesMutationOperation, { type: "database.property.add" }>["property"]["type"];

const EMPTY_PROJECTION: {
  blocks: NoteBlockView[];
  repairs: NoteTreeRepairView[];
  templates: TemplateRowDto[];
} = { blocks: [], repairs: [], templates: [] };
const EMPTY_SYMBOLS: Record<string, CodeSymbolPick[]> = {};

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function randomToken(prefix: string): string {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

let fallbackDeviceId = "";
function dashboardDeviceId(): string {
  if (typeof window === "undefined") return fallbackDeviceId || (fallbackDeviceId = randomToken("dashboard"));
  try {
    const stored = window.localStorage.getItem(DEVICE_STORAGE_KEY);
    if (stored) return stored;
    const created = randomToken("dashboard");
    window.localStorage.setItem(DEVICE_STORAGE_KEY, created);
    return created;
  } catch {
    return fallbackDeviceId || (fallbackDeviceId = randomToken("dashboard"));
  }
}

function failedDisposition(detail: string): MutationDisposition {
  return { applied: false, refreshRequired: true, detail, fencedIds: [], result: null };
}

function createdId(result: unknown, key: "block" | "row" = "block"): string | null {
  const record = objectOf(result);
  const created = objectOf(record?.[key]);
  return typeof created?.id === "string" ? created.id : null;
}

function blockOutcome(result: unknown): BlockOpOutcome | null {
  const record = objectOf(result);
  if (!record || typeof record.ok !== "boolean") return null;
  return {
    ok: record.ok,
    ...(typeof record.focusId === "string" || record.focusId === null ? { focusId: record.focusId as string | null } : {}),
    ...(typeof record.caret === "number" ? { caret: record.caret } : {}),
    ...(typeof record.createdId === "string" ? { createdId: record.createdId } : {}),
  };
}

function validBlockKind(kind: string): kind is BlockKind {
  return (NOTE_BLOCK_KINDS as readonly string[]).includes(kind);
}

function validPropertyType(type: string): type is PropertyType {
  return (NOTE_PROPERTY_TYPES as readonly string[]).includes(type);
}

function saveDownloadedFile(filename: string, contentType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface FavouriteApiRow {
  blockId: string;
  kind: string;
  title: string;
  icon: string | null;
}

interface LeaseRead {
  lease: { deviceId: string; holder?: string; epoch: number; expiresAt: number } | null;
  nowMs: number;
}

export interface DashboardNotesState {
  blocks: NoteBlockView[];
  repairs: NoteTreeRepairView[];
  syncState: string;
  revision: number;
  refLabels: Record<string, string>;
  files: string[];
  symbols: Record<string, CodeSymbolPick[]>;
  matchIds: ReadonlySet<string> | null;
  backlinkCounts: Record<string, number>;
  shell: NotesShellState;
  ops: NotesOps;
  loading: boolean;
  error: string | null;
  capabilityNotices: string[];
}

/** Authenticated, org-scoped browser host for the shared Notes presentation. */
export function useDashboardNotes(): DashboardNotesState {
  const router = useRouter();
  const { activeOrgId, loading: orgLoading, error: orgError } = useActiveOrg();
  const [snapshot, setSnapshot] = useState(EMPTY_PROJECTION);
  const [favourites, setFavourites] = useState<FavouriteRow[]>([]);
  const [trash, setTrash] = useState<TrashEntryDto[]>([]);
  const [orphanedThreads, setOrphanedThreads] = useState<OrphanedThreadDto[]>([]);
  const [capabilities, setCapabilities] = useState<NotesEditingCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [revision, setRevision] = useState(0);
  const [pageId, setPageId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [quickFindQuery, setQuickFindQuery] = useState("");
  const [quickFindHits, setQuickFindHits] = useState<QuickFindHit[]>([]);
  const [refLabels, setRefLabels] = useState<Record<string, string>>({});
  const [matchIds, setMatchIds] = useState<ReadonlySet<string> | null>(null);
  const [backlinkCounts, setBacklinkCounts] = useState<Record<string, number>>({});

  const rawBlocks = useRef<NoteBlock[]>([]);
  const scope = useRef(activeOrgId);
  const loadSequence = useRef(0);
  const capabilitiesRef = useRef<NotesEditingCapabilities | null>(null);
  const remoteLocks = useRef<Record<string, string>>({});
  const heldLeases = useRef(new Map<string, number>());
  const queueTail = useRef<Promise<void>>(Promise.resolve());
  const pendingText = useRef(new Map<string, { text: string; timer: number }>());
  const searchTimer = useRef<number | undefined>(undefined);
  const searchSequence = useRef(0);
  const quickFindTimer = useRef<number | undefined>(undefined);
  const quickFindSequence = useRef(0);
  const backlinkSequence = useRef(new Map<string, number>());
  const mentionCache = useRef<{ at: number; sources: MentionSources }>({ at: 0, sources: {} });

  const reproject = useCallback(() => {
    setSnapshot(projectNotes(rawBlocks.current, remoteLocks.current));
  }, []);

  const setRemoteLock = useCallback((id: string, detail: string | null) => {
    if (detail) {
      const pendingEntry = pendingText.current.get(id);
      if (pendingEntry) {
        window.clearTimeout(pendingEntry.timer);
        pendingText.current.delete(id);
      }
      remoteLocks.current = { ...remoteLocks.current, [id]: detail };
    } else {
      const next = { ...remoteLocks.current };
      delete next[id];
      remoteLocks.current = next;
    }
    reproject();
  }, [reproject]);

  const refresh = useCallback(async (): Promise<void> => {
    const orgId = activeOrgId;
    if (!orgId) return;
    const sequence = ++loadSequence.current;
    try {
      const lockIds = Object.keys(remoteLocks.current);
      const [blocksAnswer, favouritesAnswer, trashAnswer, orphanAnswer, capabilityAnswer, lockAnswers] = await Promise.all([
        authFetch<{ blocks: NoteBlock[] }>("/api/notes/blocks", { orgId }),
        authFetch<{ favourites: FavouriteApiRow[] }>("/api/notes/favourites", { orgId }),
        authFetch<{ entries: TrashEntryDto[] }>("/api/notes/trash", { orgId }),
        authFetch<{ threads: OrphanedThreadDto[] }>("/api/notes/comments/orphaned", { orgId }),
        authFetch<NotesEditingCapabilities>("/api/notes/mutate/capabilities", { orgId }),
        Promise.all(lockIds.map(async (id) => ({
          id,
          answer: await authFetch<LeaseRead>(`/api/notes/blocks/${encodeURIComponent(id)}/lease`, { orgId })
            .catch(() => null),
        }))),
      ]);
      if (scope.current !== orgId || sequence !== loadSequence.current) return;

      const deviceId = dashboardDeviceId();
      const nextLocks = { ...remoteLocks.current };
      for (const { id, answer } of lockAnswers) {
        if (!answer?.lease || answer.lease.expiresAt <= answer.nowMs || answer.lease.deviceId === deviceId) {
          delete nextLocks[id];
        } else {
          nextLocks[id] = answer.lease.holder?.trim() || "Another device is editing this block.";
        }
      }
      remoteLocks.current = nextLocks;
      rawBlocks.current = blocksAnswer.blocks ?? [];
      const next = projectNotes(rawBlocks.current, nextLocks);
      setSnapshot(next);
      setFavourites(favouriteRows(favouritesAnswer.favourites ?? []));
      setTrash(trashAnswer.entries ?? []);
      setOrphanedThreads(orphanAnswer.threads ?? []);
      capabilitiesRef.current = capabilityAnswer;
      setCapabilities(capabilityAnswer);
      setRevision((current) => current + 1);
      setError(null);
    } catch (caught) {
      if (scope.current === orgId && sequence === loadSequence.current) {
        setError(caught instanceof Error ? caught.message : "Could not load Notes.");
      }
    } finally {
      if (scope.current === orgId && sequence === loadSequence.current) setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => {
    scope.current = activeOrgId;
    loadSequence.current += 1;
    rawBlocks.current = [];
    remoteLocks.current = {};
    capabilitiesRef.current = null;
    setSnapshot(EMPTY_PROJECTION);
    setFavourites([]);
    setTrash([]);
    setOrphanedThreads([]);
    setCapabilities(null);
    setPageId(null);
    setExpanded(new Set());
    setQuickFindOpen(false);
    setQuickFindQuery("");
    setQuickFindHits([]);
    setRefLabels({});
    setMatchIds(null);
    setBacklinkCounts({});
    backlinkSequence.current.clear();
    setLoading(true);
    setError(null);
    mentionCache.current = { at: 0, sources: {} };
    if (activeOrgId) void refresh();
  }, [activeOrgId, refresh]);

  useEffect(() => {
    if (activeOrgId || orgLoading) return;
    setLoading(false);
    setError(orgError || "Choose or create an organization before opening Notes.");
  }, [activeOrgId, orgError, orgLoading]);

  useEffect(() => {
    if (!activeOrgId) return;
    const tick = (): void => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [activeOrgId, refresh]);

  const executeMutation = useCallback(async (
    operation: NotesMutationOperation,
    options: { refresh?: boolean; silent?: boolean } = {},
  ): Promise<MutationDisposition> => {
    const orgId = activeOrgId;
    if (!orgId) return failedDisposition("Choose an organization before editing Notes.");
    if (scope.current !== orgId) {
      return failedDisposition("The active organization changed before this Notes change began.");
    }
    const supported = capabilitiesRef.current?.operations[operation.type] === true;
    if (!supported) {
      const detail = operation.type === "attachment.upload-bytes"
        ? "Attachment bytes require a native upload host and are unavailable in the Dashboard."
        : operation.type === "history.undo" || operation.type === "history.redo"
          ? "Remote undo and redo are unavailable because browser history is not replayed by the server."
          : `This server does not support ${operation.type}.`;
      if (!options.silent) setError(detail);
      return failedDisposition(detail);
    }

    const body = notesMutationRequest(randomToken("notes"), dashboardDeviceId(), operation);
    let disposition: MutationDisposition;
    try {
      const response = await authFetch<unknown>("/api/notes/mutate", {
        orgId,
        method: "POST",
        body,
      });
      const narrowed = notesMutationResponse(response);
      disposition = narrowed
        && narrowed.requestId === body.requestId
        && narrowed.operation === operation.type
        ? mutationDisposition(narrowed)
        : failedDisposition("The Notes server returned an invalid or mismatched mutation response.");
    } catch (caught) {
      const typed = notesMutationResponse((caught as DashboardRequestError | null)?.body);
      disposition = typed
        && typed.requestId === body.requestId
        && (typed.operation === operation.type || typed.operation === "unknown")
        ? mutationDisposition(typed)
        : failedDisposition(caught instanceof Error ? caught.message : "The Notes change could not be applied.");
    }

    if (scope.current !== orgId) return failedDisposition("The active organization changed before this response arrived.");
    for (const id of disposition.fencedIds) setRemoteLock(id, disposition.detail);
    // Compound operations may defer clean refreshes, but a replay, rejection,
    // fence, or malformed reply always reconciles before the UI can continue.
    if (options.refresh !== false || disposition.refreshRequired) await refresh();
    if (!options.silent) setError(disposition.applied ? null : disposition.detail);
    return disposition;
  }, [activeOrgId, refresh, setRemoteLock]);

  const enqueue = useCallback(function enqueue<T>(task: () => Promise<T>): Promise<T> {
    setPending((count) => count + 1);
    const run = queueTail.current.then(task, task);
    queueTail.current = run.then(() => undefined, () => undefined);
    return run.finally(() => setPending((count) => Math.max(0, count - 1)));
  }, []);

  const withBlockLease = useCallback(async <T,>(
    blockId: string,
    work: (epoch: number) => Promise<T>,
  ): Promise<T | null> => {
    const held = heldLeases.current.get(blockId);
    if (held !== undefined) return work(held);

    const acquired = await executeMutation(
      { type: "lease.acquire", blockId, holder: "Dashboard" },
      { refresh: false, silent: true },
    );
    const lease = acquired.applied
      ? notesLeaseGrant(acquired.result, blockId, dashboardDeviceId())
      : null;
    if (!lease) {
      const detail = acquired.detail ?? "Another device is editing this block.";
      setRemoteLock(blockId, detail);
      setError(detail);
      return null;
    }
    try {
      return await work(lease.epoch);
    } finally {
      await executeMutation(
        { type: "lease.release", blockId, epoch: lease.epoch },
        { refresh: false, silent: true },
      );
    }
  }, [executeMutation, setRemoteLock]);

  const queueBlockUpdate = useCallback((blockId: string, patch: BlockUpdatePatch) =>
    enqueue(async () => await withBlockLease(blockId, async (epoch) =>
      executeMutation({ type: "block.update", blockId, patch, leaseEpoch: epoch }))),
  [enqueue, executeMutation, withBlockLease]);

  const cancelPendingText = useCallback((id: string): string | null => {
    const pendingEntry = pendingText.current.get(id);
    if (!pendingEntry) return null;
    window.clearTimeout(pendingEntry.timer);
    pendingText.current.delete(id);
    return pendingEntry.text;
  }, []);

  const flushText = useCallback((id: string): Promise<MutationDisposition | null> => {
    const text = cancelPendingText(id);
    return text === null ? Promise.resolve(null) : queueBlockUpdate(id, { text });
  }, [cancelPendingText, queueBlockUpdate]);

  const scheduleText = useCallback((id: string, text: string) => {
    const previous = pendingText.current.get(id);
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      const current = pendingText.current.get(id);
      if (!current || current.timer !== timer) return;
      pendingText.current.delete(id);
      void queueBlockUpdate(id, { text: current.text });
    }, TEXT_COMMIT_MS);
    pendingText.current.set(id, { text, timer });
  }, [queueBlockUpdate]);

  useEffect(() => () => {
    for (const entry of pendingText.current.values()) window.clearTimeout(entry.timer);
    pendingText.current.clear();
    window.clearTimeout(searchTimer.current);
    window.clearTimeout(quickFindTimer.current);
  }, [activeOrgId]);

  useEffect(() => {
    if (!activeOrgId) return;
    const orgId = activeOrgId;
    return () => {
      for (const [blockId, epoch] of heldLeases.current) {
        const body = notesMutationRequest(randomToken("notes"), dashboardDeviceId(), {
          type: "lease.release", blockId, epoch,
        });
        void authFetch("/api/notes/mutate", { orgId, method: "POST", body }).catch(() => {});
      }
      heldLeases.current.clear();
    };
  }, [activeOrgId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const [blockId, epoch] of heldLeases.current) {
        void enqueue(async () => {
          const renewed = await executeMutation(
            { type: "lease.renew", blockId, epoch },
            { refresh: false, silent: true },
          );
          const lease = renewed.applied
            ? notesLeaseGrant(renewed.result, blockId, dashboardDeviceId())
            : null;
          if (lease) heldLeases.current.set(blockId, lease.epoch);
          else {
            heldLeases.current.delete(blockId);
            setRemoteLock(blockId, renewed.detail ?? "The editing lock expired.");
          }
        });
      }
    }, LEASE_RENEW_MS);
    return () => window.clearInterval(timer);
  }, [enqueue, executeMutation, setRemoteLock]);

  const openPageId = useMemo(
    () => selectedPageOrTop(snapshot.blocks, pageId),
    [snapshot.blocks, pageId],
  );

  const openPage = useCallback((next: string | null) => {
    setPageId(next);
    setExpanded((current) => withAncestorsExpanded(snapshot.blocks, next, current));
  }, [snapshot.blocks]);

  const referenceKey = snapshot.blocks.flatMap((block) => block.refs).sort().join("|");
  useEffect(() => {
    const orgId = activeOrgId;
    const uris = [...new Set(snapshot.blocks.flatMap((block) => block.refs))];
    if (!orgId || uris.length === 0) {
      setRefLabels({});
      return;
    }
    let cancelled = false;
    void Promise.all(uris.map(async (uri) => {
      const answer = await authFetch<{ line?: string }>(
        `/api/workspace/describe?uri=${encodeURIComponent(uri)}`,
        { orgId },
      ).catch(() => null);
      return [uri, answer?.line ?? ""] as const;
    })).then((pairs) => {
      if (!cancelled && scope.current === orgId) {
        setRefLabels(Object.fromEntries(pairs.filter(([, line]) => line)));
      }
    });
    return () => { cancelled = true; };
    // The sorted URI key is the dependency; block identity changes every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, referenceKey]);

  const loadMentionSources = useCallback(async (): Promise<MentionSources> => {
    const now = Date.now();
    if (now - mentionCache.current.at < MENTION_TTL_MS) return mentionCache.current.sources;
    const orgId = activeOrgId;
    if (!orgId) return {};
    const [planner, track, meetings] = await Promise.all([
      authFetch<{ items?: unknown[] }>("/api/planner/items", { orgId }).catch(() => null),
      authFetch<{ items?: unknown[] }>("/api/track", { orgId }).catch(() => null),
      authFetch<{ meetings?: unknown[] }>("/api/meetings?limit=100", { orgId }).catch(() => null),
    ]);
    if (scope.current !== orgId) return {};
    if (!planner || !track || !meetings) {
      setError("Some workspace mention sources could not be loaded; unavailable modes were left out of the picker.");
    }

    const plannerRows = (planner?.items ?? []).flatMap((value) => {
      const item = objectOf(value);
      const titleStamp = objectOf(item?.title);
      const id = typeof item?.id === "string" ? item.id : "";
      const title = typeof titleStamp?.value === "string"
        ? titleStamp.value
        : typeof item?.title === "string" ? item.title : "";
      return id && title ? [{
        id,
        title,
        completed: item?.completedAt !== undefined || objectOf(item?.completed)?.value === true,
      }] : [];
    });
    const workRows = (track?.items ?? []).flatMap((value) => {
      const item = objectOf(value);
      const id = typeof item?.id === "string" ? item.id : "";
      const title = typeof item?.title === "string" ? item.title : "";
      return id && title ? [{
        id,
        ...(typeof item?.key === "string" ? { key: item.key } : {}),
        title,
      }] : [];
    });
    const meetingRows = (meetings?.meetings ?? []).flatMap((value) => {
      const meeting = objectOf(value);
      return typeof meeting?.id === "string" && typeof meeting?.title === "string"
        ? [{ id: meeting.id, title: meeting.title }]
        : [];
    });
    const sources: MentionSources = {
      pages: snapshot.blocks
        .filter((block) => block.kind === "page")
        .map((block) => ({ id: block.id, title: block.title ?? block.text })),
      databases: snapshot.blocks
        .filter((block) => block.kind === "database")
        .map((block) => ({ id: block.id, title: block.title ?? block.text })),
      planner: plannerRows,
      workItems: workRows,
      meetings: meetingRows,
    };
    mentionCache.current = { at: now, sources };
    return sources;
  }, [activeOrgId, snapshot.blocks]);

  const onOpenRef = useCallback((uri: string) => {
    const match = /^brainrouter:\/\/([^/]+)\/([^/]+)\/(.+)$/i.exec(uri.trim());
    if (!match) {
      setError("That workspace link is malformed.");
      return;
    }
    const mode = match[1]!.toLowerCase();
    let id: string;
    try {
      id = decodeURIComponent(match[3]!.split("#", 1)[0]!);
    } catch {
      setError("That workspace link has an invalid encoded identifier.");
      return;
    }
    if (mode === "notes") {
      const block = snapshot.blocks.find((candidate) => candidate.id === id);
      if (!block) {
        setError("That note is not available in this organization.");
        return;
      }
      const parents = containerParents(snapshot.blocks);
      openPage(block.kind === "page" || block.kind === "database"
        ? block.id
        : parents.get(block.id) ?? null);
      return;
    }
    if (mode === "planner") router.push("/planner");
    else if (mode === "track") router.push("/track");
    else if (mode === "meetings") router.push("/meetings");
    else setError(`The ${mode} target cannot be opened from this Dashboard.`);
  }, [openPage, router, snapshot.blocks]);

  const runSearch = useCallback((query: string) => {
    window.clearTimeout(searchTimer.current);
    const sequence = ++searchSequence.current;
    if (!query.trim()) {
      setMatchIds(null);
      return;
    }
    const orgId = activeOrgId;
    searchTimer.current = window.setTimeout(() => {
      void authFetch<{ hits?: Array<{ blockId: string }> }>(
        `/api/notes/search?q=${encodeURIComponent(query)}&limit=100`,
        { orgId },
      ).then((answer) => {
        if (scope.current === orgId && searchSequence.current === sequence) {
          setMatchIds(new Set((answer.hits ?? []).map((hit) => hit.blockId)));
        }
      }).catch((caught) => {
        if (scope.current === orgId && searchSequence.current === sequence) {
          setError(caught instanceof Error ? caught.message : "Notes search failed.");
        }
      });
    }, SEARCH_MS);
  }, [activeOrgId]);

  const runQuickFind = useCallback((query: string) => {
    setQuickFindQuery(query);
    window.clearTimeout(quickFindTimer.current);
    const sequence = ++quickFindSequence.current;
    if (!query.trim()) {
      setQuickFindHits([]);
      return;
    }
    const orgId = activeOrgId;
    quickFindTimer.current = window.setTimeout(() => {
      void authFetch<{ hits?: QuickFindHit[] }>(
        `/api/notes/search?q=${encodeURIComponent(query)}&limit=100`,
        { orgId },
      ).then((answer) => {
        if (scope.current === orgId && quickFindSequence.current === sequence) {
          setQuickFindHits(answer.hits ?? []);
        }
      }).catch((caught) => {
        if (scope.current === orgId && quickFindSequence.current === sequence) {
          setError(caught instanceof Error ? caught.message : "Quick find failed.");
        }
      });
    }, SEARCH_MS);
  }, [activeOrgId]);

  const addBlock = useCallback(async (
    afterId: string | null,
    kind = "paragraph",
    level?: number,
  ): Promise<{ id: string } | null> => {
    if (!validBlockKind(kind)) {
      setError(`“${kind}” is not a supported Notes block kind.`);
      return null;
    }
    const result = await enqueue(() => executeMutation({
      type: "block.create",
      input: {
        kind,
        ...(afterId ? { after: afterId } : { parentId: openPageId }),
        ...(level === undefined ? {} : { level }),
      },
    }));
    const id = result.applied ? createdId(result.result) : null;
    return id ? { id } : null;
  }, [enqueue, executeMutation, openPageId]);

  const addPage = useCallback((parentId: string | null) => {
    void enqueue(async () => {
      const intent = newPageIntent(parentId);
      const result = await executeMutation({
        type: "block.create",
        input: { kind: "page", text: intent.title, parentId: intent.parentId },
      });
      const id = result.applied ? createdId(result.result) : null;
      if (id) openPage(id);
    });
  }, [enqueue, executeMutation, openPage]);

  const moveBlock = useCallback((intent: { id: string; parentId: string | null; before?: string; after?: string }) => {
    void enqueue(() => executeMutation({
      type: "block.move",
      blockId: intent.id,
      to: {
        parentId: intent.parentId,
        ...(intent.before ? { before: intent.before } : {}),
        ...(intent.after ? { after: intent.after } : {}),
      },
    }));
  }, [enqueue, executeMutation]);

  const deleteBlock = useCallback((id: string) => {
    cancelPendingText(id);
    void enqueue(() => executeMutation({ type: "block.delete", blockId: id }));
  }, [cancelPendingText, enqueue, executeMutation]);

  const gesture = useCallback(async (
    id: string,
    operation: (epoch?: number) => NotesMutationOperation,
    fenced: boolean,
  ): Promise<BlockOpOutcome | null> => {
    await flushText(id);
    const disposition = await enqueue(async () => {
      if (!fenced) return executeMutation(operation());
      return await withBlockLease(id, (epoch) => executeMutation(operation(epoch)));
    });
    return disposition?.applied ? blockOutcome(disposition.result) : null;
  }, [enqueue, executeMutation, flushText, withBlockLease]);

  const beginEdit = useCallback((id: string): Promise<boolean> => {
    if (heldLeases.current.has(id)) return Promise.resolve(true);
    return enqueue(async () => {
      if (heldLeases.current.has(id)) return true;
      const acquired = await executeMutation(
        { type: "lease.acquire", blockId: id, holder: "Dashboard" },
        { refresh: false, silent: true },
      );
      const lease = acquired.applied
        ? notesLeaseGrant(acquired.result, id, dashboardDeviceId())
        : null;
      if (lease) {
        heldLeases.current.set(id, lease.epoch);
        setRemoteLock(id, null);
        return true;
      } else {
        setRemoteLock(id, acquired.detail ?? "Another device is editing this block.");
        setError(acquired.detail ?? "Another device is editing this block.");
        return false;
      }
    });
  }, [enqueue, executeMutation, setRemoteLock]);

  const endEdit = useCallback((id: string) => {
    void (async () => {
      await flushText(id);
      await enqueue(async () => {
        const epoch = heldLeases.current.get(id);
        if (epoch === undefined) return;
        heldLeases.current.delete(id);
        await executeMutation(
          { type: "lease.release", blockId: id, epoch },
          { refresh: false, silent: true },
        );
      });
    })();
  }, [enqueue, executeMutation, flushText]);

  const addTableRow = useCallback((tableId: string, text: string, after?: string) => {
    void enqueue(() => executeMutation({
      type: "block.create",
      input: { parentId: tableId, kind: "table-row", text, ...(after ? { after } : {}) },
    }));
  }, [enqueue, executeMutation]);

  const startTable = useCallback((tableId: string) => {
    if (snapshot.blocks.some((block) => block.parentId === tableId && block.kind === "table-row")) return;
    void enqueue(async () => {
      const header = await executeMutation({
        type: "block.create",
        input: {
          parentId: tableId,
          kind: "table-row",
          text: defaultTableHeader(NEW_TABLE_COLUMNS),
        },
      }, { refresh: false });
      if (!header.applied) { await refresh(); return; }
      const headerId = createdId(header.result);
      const row = await executeMutation({
        type: "block.create",
        input: {
          parentId: tableId,
          kind: "table-row",
          text: emptyTableRow(NEW_TABLE_COLUMNS),
          ...(headerId ? { after: headerId } : {}),
        },
      }, { refresh: false });
      if (!row.applied) { await refresh(); return; }
      await withBlockLease(tableId, (epoch) => executeMutation({
        type: "block.update",
        blockId: tableId,
        patch: { checked: true },
        leaseEpoch: epoch,
      }));
    });
  }, [enqueue, executeMutation, refresh, snapshot.blocks, withBlockLease]);

  const writeRows = useCallback((writes: readonly { id: string; text: string }[]) => {
    for (const write of writes) cancelPendingText(write.id);
    void enqueue(async () => {
      for (const write of writes) {
        const outcome = await withBlockLease(write.id, (epoch) => executeMutation({
          type: "block.update",
          blockId: write.id,
          patch: { text: write.text },
          leaseEpoch: epoch,
        }, { refresh: false }));
        if (!outcome?.applied) break;
      }
      await refresh();
    });
  }, [cancelPendingText, enqueue, executeMutation, refresh, withBlockLease]);

  const sendTo = useCallback((id: string, target: NoteSendTarget) => {
    void (async () => {
      await flushText(id);
      await enqueue(async () => {
        const block = projectNotes(rawBlocks.current, remoteLocks.current).blocks.find((candidate) => candidate.id === id);
        if (!block?.text.trim()) {
          setError("Write something before sending this line to another mode.");
          return;
        }
        const created = await authFetch<unknown>("/api/workspace/create", {
          orgId: activeOrgId,
          method: "POST",
          body: {
            mode: target.mode,
            kind: target.kind,
            title: block.text.trim(),
            from: { mode: "notes", kind: "block", id },
          },
        }).catch((caught) => {
          setError(caught instanceof Error ? caught.message : "The target could not be created.");
          return null;
        });
        if (scope.current !== activeOrgId) return;
        const ref = objectOf(objectOf(created)?.ref);
        if (!ref || typeof ref.id !== "string") {
          if (created !== null) setError("The target was not created, so the note was left unchanged.");
          return;
        }
        const uri = target.mode === "planner"
          ? plannerItemUri(ref.id)
          : target.mode === "track" ? workItemUri(ref.id) : null;
        if (!uri) {
          setError(`The ${target.mode} target cannot be linked from this Dashboard.`);
          return;
        }
        const latest = projectNotes(rawBlocks.current, remoteLocks.current).blocks.find((candidate) => candidate.id === id)?.text ?? block.text;
        const text = `${latest.trimEnd()}${latest.trim() ? " " : ""}${uri}`;
        await withBlockLease(id, (epoch) => executeMutation({
          type: "block.update", blockId: id, patch: { text }, leaseEpoch: epoch,
        }));
      });
    })();
  }, [activeOrgId, enqueue, executeMutation, flushText, withBlockLease]);

  const loadBacklinks = useCallback((id: string) => {
    const orgId = activeOrgId;
    const uri = noteBlockUri(id);
    const sequence = (backlinkSequence.current.get(id) ?? 0) + 1;
    backlinkSequence.current.set(id, sequence);
    void authFetch<{ backlinks?: unknown[] }>(
      `/api/notes/backlinks?target=${encodeURIComponent(uri)}`,
      { orgId },
    ).then((answer) => {
      if (scope.current === orgId && backlinkSequence.current.get(id) === sequence) {
        setBacklinkCounts((current) => ({ ...current, [id]: answer.backlinks?.length ?? 0 }));
      }
    }).catch((caught) => {
      if (scope.current === orgId && backlinkSequence.current.get(id) === sequence) {
        setError(caught instanceof Error ? caught.message : "Backlinks could not be read.");
      }
    });
  }, [activeOrgId]);

  const database = useMemo<DatabaseHostOps>(() => ({
    read: async (databaseId, viewId): Promise<DatabaseReadDto | null> => {
      try {
        const query = new URLSearchParams({ limit: "500" });
        if (viewId) query.set("view", viewId);
        const answer = await authFetch<DatabaseProjectionResponse>(
          `/api/notes/databases/${encodeURIComponent(databaseId)}?${query.toString()}`,
          { orgId: activeOrgId },
        );
        return projectDatabase(databaseId, answer);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "That database could not be read.");
        return null;
      }
    },
    addRow: async (databaseId, after) => {
      const outcome = await enqueue(() => executeMutation({
        type: "database.row.create",
        databaseId,
        ...(after ? { after } : {}),
      }));
      return outcome.applied ? createdId(outcome.result, "row") : null;
    },
    setValue: async (rowId, propertyId, value) => {
      await enqueue(async () => {
        await withBlockLease(rowId, (epoch) => executeMutation({
          type: "database.row.set", rowId, propertyId, value, leaseEpoch: epoch,
        }));
      });
    },
    removeRow: async (rowId) => {
      await enqueue(() => executeMutation({ type: "database.row.delete", rowId }));
    },
    addProperty: async (databaseId, name, type, config) => {
      if (!validPropertyType(type)) {
        setError(`“${type}” is not a writable Notes property type.`);
        return;
      }
      await enqueue(async () => {
        await withBlockLease(databaseId, (epoch) => executeMutation({
          type: "database.property.add",
          databaseId,
          property: {
            name,
            type,
            ...(config?.formula === undefined ? {} : { formula: config.formula }),
            ...(config?.rollup === undefined ? {} : { rollup: config.rollup }),
          },
          leaseEpoch: epoch,
        }));
      });
    },
    updateProperty: async (databaseId, propertyId, patch) => {
      await enqueue(async () => {
        await withBlockLease(databaseId, (epoch) => executeMutation({
          type: "database.property.update",
          databaseId,
          propertyId,
          patch: {
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.options === undefined ? {} : { options: patch.options }),
            ...(patch.formula === undefined ? {} : { formula: patch.formula }),
            ...(patch.rollup === undefined ? {} : { rollup: patch.rollup }),
          },
          leaseEpoch: epoch,
        }));
      });
    },
    removeProperty: async (databaseId, propertyId) => {
      await enqueue(async () => {
        await withBlockLease(databaseId, (epoch) => executeMutation({
          type: "database.property.delete", databaseId, propertyId, leaseEpoch: epoch,
        }));
      });
    },
    reorderProperties: async (databaseId, order) => {
      await enqueue(async () => {
        await withBlockLease(databaseId, (epoch) => executeMutation({
          type: "database.property.reorder", databaseId, order: [...order], leaseEpoch: epoch,
        }));
      });
    },
    propertyCatalog: async (): Promise<PropertyCatalogDto> => propertyCatalog(),
    saveView: async (databaseId, input: SaveViewInput) => {
      await enqueue(async () => {
        await withBlockLease(databaseId, (epoch) => executeMutation({
          type: "database.view.save",
          databaseId,
          view: {
            ...(input.viewId === undefined ? {} : { id: input.viewId }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.visible === undefined ? {} : { visible: input.visible }),
            ...(input.filter === undefined ? {} : { filter: input.filter }),
            ...(input.sort === undefined ? {} : { sort: input.sort }),
            ...(input.groupBy === undefined ? {} : { groupBy: input.groupBy }),
          },
          leaseEpoch: epoch,
        }));
      });
    },
    removeView: async (databaseId, viewId) => {
      await enqueue(async () => {
        await withBlockLease(databaseId, (epoch) => executeMutation({
          type: "database.view.delete", databaseId, viewId, leaseEpoch: epoch,
        }));
      });
    },
    rollupTargets: async (databaseId, relationPropertyId): Promise<RollupTargetsDto> => {
      try {
        return await authFetch<RollupTargetsDto>(
          `/api/notes/databases/${encodeURIComponent(databaseId)}/rollup-targets?relation=${encodeURIComponent(relationPropertyId)}`,
          { orgId: activeOrgId },
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Rollup targets could not be read.");
        return { ok: false };
      }
    },
    openPage,
    openRef: onOpenRef,
    searchRefs: async (query): Promise<MentionCandidate[]> => mentionCandidates(await loadMentionSources(), query),
  }), [activeOrgId, enqueue, executeMutation, loadMentionSources, onOpenRef, openPage, withBlockLease]);

  const hostCapabilities = useMemo<NotesHostCapabilities>(() => ({
    liveReferences: {
      resolve: async (uri): Promise<WorkspaceResolutionDto | null> => {
        try {
          return await authFetch<WorkspaceResolutionDto>(
            `/api/workspace/resolve?uri=${encodeURIComponent(uri)}`,
            { orgId: activeOrgId },
          );
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "That reference could not be resolved.");
          return null;
        }
      },
      readSynced: async (blockId): Promise<SyncedReadDto | null> => {
        const mirror = rawBlocks.current.find((block) => block.id === blockId);
        if (!mirror) return null;
        const uri = mirror.text.value.trim();
        if (uri) {
          const answer = await authFetch<WorkspaceResolutionDto>(
            `/api/workspace/resolve?uri=${encodeURIComponent(uri)}`,
            { orgId: activeOrgId },
          ).catch(() => null);
          const status = answer?.resolution?.status;
          if (status && status !== "found") {
            return {
              status: status === "denied" ? "denied" : "gone",
              uri,
              note: answer?.line?.trim() || "This linked block could not be read here.",
              rows: [],
            };
          }
        }
        return projectSynced(rawBlocks.current, projectNotes(rawBlocks.current, remoteLocks.current).blocks, blockId);
      },
    },
    export: {
      exportPage: async (blockId, format) => {
        try {
          const query = new URLSearchParams({ format });
          const file = await authDownload(
            `/api/notes/blocks/${encodeURIComponent(blockId)}/export?${query.toString()}`,
            { orgId: activeOrgId },
          );
          saveDownloadedFile(file.filename, file.contentType, file.content);
          const qualifications = [
            ...(file.truncated ? ["The server bounded this export; the file says where it stops."] : []),
            ...(file.omissions.length > 0 ? [`It omits: ${file.omissions.join(", ")}.`] : []),
          ];
          return `Saved ${file.filename}.${qualifications.length ? ` ${qualifications.join(" ")}` : ""}`;
        } catch (caught) {
          return caught instanceof Error ? caught.message : "That page could not be exported.";
        }
      },
    },
    clipboard: {
      copyBlockLink: (id) => {
        void navigator.clipboard.writeText(blockLinkUri(id)).catch(() => {
          setError("The browser did not allow clipboard access.");
        });
      },
    },
  }), [activeOrgId]);

  const ops: NotesOps = {
    capabilities: hostCapabilities,
    addBlock,
    addPage,
    openPage,
    toggleExpanded: (id) => setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    }),
    movePage: moveBlock,
    moveBlock,
    setPageTitle: scheduleText,
    setIcon: (id, icon) => { void queueBlockUpdate(id, { icon }); },
    setCover: (id, cover) => { void queueBlockUpdate(id, { cover }); },
    setFavourite: (id, favourite) => { void queueBlockUpdate(id, { favourite }); },
    restore: (id) => { void enqueue(() => executeMutation({ type: "block.restore", blockId: id })); },
    openQuickFind: () => setQuickFindOpen(true),
    closeQuickFind: () => setQuickFindOpen(false),
    quickFindQuery: runQuickFind,
    setText: scheduleText,
    setKind: (id, kind, level) => {
      if (!validBlockKind(kind)) {
        setError(`“${kind}” is not a supported Notes block kind.`);
        return;
      }
      void queueBlockUpdate(id, { kind, ...(level === undefined ? {} : { level }) });
    },
    toggleChecked: (id, checked) => { void queueBlockUpdate(id, { checked }); },
    deleteBlock,
    setCollapsed: (id, collapsed) => { void queueBlockUpdate(id, { collapsed }); },
    addTableRow,
    startTable,
    writeRows,
    splitBlock: (id, caret) => gesture(
      id,
      (epoch) => ({ type: "gesture.split", blockId: id, caret, ...(epoch ? { leaseEpoch: epoch } : {}) }),
      true,
    ),
    mergeBack: (id) => gesture(
      id,
      (epoch) => ({ type: "gesture.merge", blockId: id, ...(epoch ? { leaseEpoch: epoch } : {}) }),
      true,
    ),
    duplicate: (id) => gesture(id, () => ({ type: "gesture.duplicate", blockId: id }), false),
    moveUp: (id) => gesture(id, () => ({ type: "gesture.move", blockId: id, direction: -1 }), false),
    moveDown: (id) => gesture(id, () => ({ type: "gesture.move", blockId: id, direction: 1 }), false),
    indent: (id) => gesture(id, () => ({ type: "gesture.indent", blockId: id }), false),
    outdent: (id) => gesture(id, () => ({ type: "gesture.outdent", blockId: id }), false),
    inputRule: async (request) => {
      if (!validBlockKind(request.kind)) return null;
      return applyInputRule({ ...request, kind: request.kind });
    },
    applyRule: (id, transform: InputRuleTransformDto) => {
      cancelPendingText(id);
      if (!validBlockKind(transform.kind)) {
        setError(`“${transform.kind}” is not a supported Notes block kind.`);
        return;
      }
      void queueBlockUpdate(id, {
        text: transform.text,
        kind: transform.kind,
        ...(transform.level === undefined ? {} : { level: transform.level }),
        ...(transform.checked === undefined ? {} : { checked: transform.checked }),
        ...(transform.language === undefined ? {} : { language: transform.language }),
      });
    },
    searchSlash: async (query) => searchSlashCatalog(query, 12),
    searchMentions: async (query) => mentionCandidates(await loadMentionSources(), query),
    beginEdit,
    endEdit,
    resolveConflict: (id, field, keep, expected) => {
      void enqueue(() => executeMutation({
        type: "conflict.resolve",
        blockId: id,
        field,
        keep,
        expected,
      }));
    },
    sendTo,
    // The shared renderer capability-gates this path when `files` is empty.
    // Defensive callbacks still fail visibly if invoked outside that contract.
    linkFile: () => setError("Code-file links require a checked-out workspace and are unavailable in the Dashboard."),
    loadSymbols: () => {
      setError("Code symbols require a checked-out workspace and are unavailable in the Dashboard.");
    },
    openRef: onOpenRef,
    search: runSearch,
    loadBacklinks,
    addComment: (blockId, body) => {
      void enqueue(() => executeMutation({ type: "comment.add", blockId, body }));
    },
    editComment: (blockId, commentId, body) => {
      void enqueue(() => executeMutation({ type: "comment.edit", blockId, commentId, body }));
    },
    setCommentResolved: (blockId, commentId, resolved) => {
      void enqueue(() => executeMutation({ type: "comment.resolve", blockId, commentId, resolved }));
    },
    removeComment: (blockId, commentId) => {
      void enqueue(() => executeMutation({ type: "comment.delete", blockId, commentId }));
    },
    orphanedThreads,
    setTemplate: (id, template) => { void queueBlockUpdate(id, { template }); },
    listTemplates: async () => snapshot.templates,
    instantiateTemplate: async (templateId, parentId) => {
      const outcome = await enqueue(() => executeMutation({
        type: "template.instantiate", templateId, parentId,
      }));
      if (!outcome.applied) return outcome.detail;
      const result = objectOf(outcome.result);
      if (typeof result?.pageId === "string") openPage(result.pageId);
      return typeof result?.line === "string" ? result.line : null;
    },
    database,
    addDatabase: (parentId, after) => {
      void enqueue(() => executeMutation({
        type: "block.create",
        input: {
          kind: "database",
          text: "",
          parentId,
          ...(after ? { after } : {}),
        },
      }));
    },
  };

  const capabilityNotices = capabilities ? [
    ...(!capabilities.history.undo || !capabilities.history.redo
      ? ["Remote undo and redo are unavailable in the Dashboard because per-device history is not replayed by the server."]
      : []),
    ...(!capabilities.attachments.bytes
      ? ["Attachment byte upload requires a native upload host. Existing attachment metadata remains readable, but the Dashboard does not pretend to upload files."]
      : []),
  ] : [];

  const shell: NotesShellState = {
    pageId: openPageId,
    expanded,
    favourites,
    trash,
    quickFindOpen,
    quickFindQuery,
    quickFindHits,
  };

  return {
    blocks: snapshot.blocks,
    repairs: snapshot.repairs,
    syncState: pending > 0
      ? "Saving…"
      : error ? "The last action needs attention." : "Everything is synced.",
    revision,
    refLabels,
    files: [],
    symbols: EMPTY_SYMBOLS,
    matchIds,
    backlinkCounts,
    shell,
    ops,
    loading: loading || (!!activeOrgId && capabilities === null),
    error,
    capabilityNotices,
  };
}
