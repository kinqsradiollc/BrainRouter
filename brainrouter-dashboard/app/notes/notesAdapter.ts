import {
  NOTES_EDITING_CAPABILITIES,
  NOTES_EDITING_CONTRACT_VERSION,
  NOTE_PROPERTY_TYPES,
  NOTE_ROLLUP_AGGREGATES,
  NOTE_VIEW_KINDS,
  FORMULA_FUNCTIONS,
  blockComments,
  blockReferences,
  buildNoteTree,
  describeSyncedState,
  isDerivedPropertyType,
  numberedOrdinals,
  operatorsFor,
  pageTitleOrDefault,
  readSyncedBlock,
  subtreeBlockIds,
  type DatabaseReadDto,
  type FavouriteRow,
  type NoteBlock,
  type NoteBlockView,
  type NotesMutationOperation,
  type NotesMutationRequest,
  type NotesMutationResponse,
  type NoteTreeRepairView,
  type PropertyCatalogDto,
  type SyncedReadDto,
  type TemplateRowDto,
} from "@kinqs/brainrouter-ui/notes";

/** The mutation body is deliberately constructed from the shared contract.
 *  Org and user scope never enter it; authenticated Dashboard transport adds
 *  the active-org header and the server derives the user from the token. */
export function notesMutationRequest(
  requestId: string,
  deviceId: string,
  operation: NotesMutationOperation,
): NotesMutationRequest {
  return {
    version: NOTES_EDITING_CONTRACT_VERSION,
    requestId,
    deviceId,
    operation,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface NotesLeaseGrant {
  epoch: number;
  holder?: string;
}

/** Accept only a lease granted to this exact editor and block. */
export function notesLeaseGrant(
  result: unknown,
  expectedBlockId: string,
  expectedDeviceId: string,
): NotesLeaseGrant | null {
  const lease = recordOf(recordOf(result)?.lease);
  return lease
    && lease.blockId === expectedBlockId
    && lease.deviceId === expectedDeviceId
    && typeof lease.epoch === "number"
    && Number.isSafeInteger(lease.epoch)
    && lease.epoch > 0
    && typeof lease.expiresAt === "number"
    ? { epoch: lease.epoch, ...(typeof lease.holder === "string" ? { holder: lease.holder } : {}) }
    : null;
}

/** Runtime-narrow a JSON response without inventing a second operation union. */
export function notesMutationResponse(value: unknown): NotesMutationResponse | null {
  const record = recordOf(value);
  const sync = recordOf(record?.sync);
  const history = recordOf(record?.history);
  const operationKnown = typeof record?.operation === "string"
    && Object.prototype.hasOwnProperty.call(NOTES_EDITING_CAPABILITIES.operations, record.operation);
  if (!record || record.version !== NOTES_EDITING_CONTRACT_VERSION
    || typeof record.requestId !== "string" || (!operationKnown && record.operation !== "unknown")
    || typeof record.ok !== "boolean" || !sync || !history
    || !Array.isArray(sync.accepted) || !sync.accepted.every((entry) => typeof entry === "string")
    || !Array.isArray(sync.rejected) || !sync.rejected.every((entry) => {
      const rejection = recordOf(entry);
      return typeof rejection?.idempotencyKey === "string" && typeof rejection.reason === "string";
    })
    || !Array.isArray(sync.fenced) || !sync.fenced.every((entry) => {
      const fence = recordOf(entry);
      return typeof fence?.idempotencyKey === "string"
        && typeof fence.itemId === "string" && typeof fence.reason === "string";
    })
    || history.scope !== "remote" || history.canUndo !== false || history.canRedo !== false
    || history.reason !== "remote_history_unavailable" || typeof history.detail !== "string") {
    return null;
  }
  if (record.ok) {
    return operationKnown && "result" in record
      ? record as unknown as NotesMutationResponse
      : null;
  }
  const error = recordOf(record.error);
  return error && typeof error.code === "string" && typeof error.detail === "string"
    && typeof error.retryable === "boolean"
    ? record as unknown as NotesMutationResponse
    : null;
}

export interface MutationDisposition {
  /** True only when the server says the visible mutation applied cleanly. */
  applied: boolean;
  /** Re-read before showing any result as current. */
  refreshRequired: boolean;
  detail: string | null;
  fencedIds: string[];
  result: unknown;
}

/** Fencing, rejection, and replay all reconcile; none is optimistic success. */
export function mutationDisposition(response: NotesMutationResponse): MutationDisposition {
  const fencedIds = response.sync.fenced.map((entry) => entry.itemId);
  const fenced = response.sync.fenced[0];
  const rejected = response.sync.rejected[0];
  if (!response.ok) {
    return {
      applied: false,
      refreshRequired: true,
      detail: response.error.detail,
      fencedIds,
      result: null,
    };
  }

  const result = recordOf(response.result);
  if (result?.replayed === true || result?.refreshRequired === true) {
    return {
      applied: false,
      refreshRequired: true,
      detail: typeof result.detail === "string"
        ? result.detail
        : "This change was already received. The merged server copy has been reloaded.",
      fencedIds,
      result: response.result,
    };
  }
  if (fenced) {
    return {
      applied: false,
      refreshRequired: true,
      detail: `Another editor won the lock for ${fenced.itemId} (${fenced.reason}). Both versions remain available for reconciliation.`,
      fencedIds,
      result: response.result,
    };
  }
  if (rejected) {
    return {
      applied: false,
      refreshRequired: true,
      detail: rejected.reason,
      fencedIds,
      result: response.result,
    };
  }
  return {
    applied: true,
    refreshRequired: false,
    detail: null,
    fencedIds,
    result: response.result,
  };
}

export interface ProjectedNotes {
  blocks: NoteBlockView[];
  repairs: NoteTreeRepairView[];
  templates: TemplateRowDto[];
}

/**
 * Flatten the server's stamped records through Core's exact tree, numbering,
 * comment, title, and reference policies re-exported by the shared UI facade.
 * The Dashboard does no independent traversal or reference decoding.
 */
export function projectNotes(
  rawBlocks: readonly NoteBlock[],
  lockedBy: Readonly<Record<string, string>> = {},
): ProjectedNotes {
  const tree = buildNoteTree(rawBlocks);
  const ordinals = numberedOrdinals(tree.roots);
  const blocks: NoteBlockView[] = [];

  const walk = (nodes: typeof tree.roots): void => {
    for (const node of nodes) {
      const block = node.block;
      blocks.push({
        id: block.id,
        parentId: block.parentId.value,
        depth: node.depth,
        kind: block.kind.value,
        text: block.text.value,
        checked: block.checked?.value === true,
        level: block.level?.value ?? null,
        hasChildren: node.children.length > 0,
        collapsed: block.collapsed?.value === true,
        title: block.kind.value === "page" || block.kind.value === "database"
          ? pageTitleOrDefault(block)
          : null,
        icon: block.icon?.value ?? null,
        cover: block.cover?.value ?? null,
        favourite: block.favourite?.value === true,
        template: block.template?.value === true,
        comments: blockComments(block).map((comment) => ({
          id: comment.id,
          body: comment.body.value,
          author: comment.author,
          resolved: comment.resolved.value === true,
          createdAtMs: comment.createdAt.physical,
        })),
        ordinal: ordinals.get(block.id) ?? null,
        refs: blockReferences(block),
        conflicts: Object.entries(block.conflicts ?? {}).map(([field, conflict]) => ({
          field,
          reason: conflict.reason,
          oursAt: conflict.oursAt,
          theirsAt: conflict.theirsAt,
        })),
        lockedBy: lockedBy[block.id] ?? null,
      });
      walk(node.children);
    }
  };
  walk(tree.roots);

  const templates = rawBlocks
    .filter((block) => block.template?.value === true && (block.kind.value === "page" || block.kind.value === "database"))
    .map((block) => ({
      id: block.id,
      title: pageTitleOrDefault(block),
      icon: block.icon?.value ?? null,
      blocks: subtreeBlockIds(rawBlocks, block.id).length,
    }));

  return { blocks, repairs: tree.repairs, templates };
}

/** The `/favourites` endpoint is already Core's ranked projection. */
export function favouriteRows(rows: readonly {
  blockId: string;
  kind: string;
  title: string;
  icon: string | null;
}[]): FavouriteRow[] {
  return rows.map((row) => ({
    id: row.blockId,
    kind: row.kind,
    title: row.title,
    icon: row.icon,
  }));
}

type PropertyDef = NonNullable<NoteBlock["schema"]>["value"][number];
type CellValue = DatabaseReadDto["rows"][number]["cells"][number]["value"];

export interface DatabaseProjectionResponse {
  projection: {
    database: NoteBlock;
    title: string;
    view: DatabaseReadDto["view"];
    kind: DatabaseReadDto["kind"];
    columns: PropertyDef[];
    rows: Array<{
      id: string;
      title: string;
      icon: string | null;
      cover: string | null;
      cells: Array<{
        property: PropertyDef;
        value: CellValue;
        display: string;
        unsupported: boolean;
        computed?: boolean;
        error?: string;
      }>;
    }>;
    groups: Array<{
      key: string | null;
      label: string;
      empty: boolean;
      rows: Array<{ id: string }>;
    }>;
    total: number;
    filteredOut: number;
    skipped: DatabaseReadDto["skipped"];
    notices: string[];
  };
  views: DatabaseReadDto["views"];
  rowsInDatabase: number;
  rowsRead: number;
}

/** Adapt the server-computed projection; filtering/sorting/grouping stay server-side. */
export function projectDatabase(
  databaseId: string,
  response: DatabaseProjectionResponse,
): DatabaseReadDto {
  const { projection } = response;
  const schema = projection.database.schema?.value ?? [];
  const notices = [...projection.notices];
  if (response.rowsRead < response.rowsInDatabase) {
    notices.push(`Showing ${response.rowsRead} of ${response.rowsInDatabase} rows; this view is bounded by the server.`);
  }
  return {
    found: true,
    id: databaseId,
    title: projection.title,
    views: response.views,
    view: projection.view,
    kind: projection.kind,
    properties: schema.map((property) => ({
      ...property,
      unsupported: !(NOTE_PROPERTY_TYPES as readonly string[]).includes(property.type),
      operators: operatorsFor(property),
    })),
    columns: projection.columns.map((property) => property.id),
    rows: projection.rows.map((row) => ({
      id: row.id,
      title: row.title,
      icon: row.icon,
      cover: row.cover,
      cells: row.cells.map((cell) => ({
        property: cell.property.id,
        value: cell.value,
        display: cell.display,
        unsupported: cell.unsupported,
        ...(cell.computed === undefined ? {} : { computed: cell.computed }),
        ...(cell.error ? { error: cell.error } : {}),
      })),
    })),
    groups: projection.groups.map((group) => ({
      key: group.key,
      label: group.label,
      empty: group.empty,
      rowIds: group.rows.map((row) => row.id),
    })),
    total: projection.total,
    filteredOut: projection.filteredOut,
    skipped: projection.skipped,
    notices,
  };
}

/** Exact Core catalog surfaced through the UI facade; no Dashboard list/codec. */
export function propertyCatalog(): PropertyCatalogDto {
  return {
    types: NOTE_PROPERTY_TYPES.map((type) => ({
      type,
      operators: operatorsFor({ id: type, name: type, type }),
      derived: isDerivedPropertyType(type),
    })),
    viewKinds: NOTE_VIEW_KINDS,
    functions: FORMULA_FUNCTIONS,
    aggregates: NOTE_ROLLUP_AGGREGATES,
  };
}

/** Project Core's synced-subtree answer into the renderer's flat DTO. */
export function projectSynced(
  rawBlocks: readonly NoteBlock[],
  projected: readonly NoteBlockView[],
  mirrorId: string,
): SyncedReadDto | null {
  const mirror = rawBlocks.find((block) => block.id === mirrorId);
  if (!mirror) return null;
  const state = readSyncedBlock(rawBlocks, mirror);
  const uri = "uri" in state ? state.uri : "";
  const note = describeSyncedState(state);
  if (state.status !== "ready") return { status: state.status, uri, note, rows: [] };

  const byId = new Map(projected.map((block) => [block.id, block] as const));
  const sourceDepth = byId.get(state.source.id)?.depth ?? 0;
  return {
    status: "ready",
    uri,
    note,
    sourceId: state.source.id,
    omittedLabel: state.omittedLabel ?? null,
    rows: state.blockIds.flatMap((id) => {
      const block = byId.get(id);
      return block ? [{
        id: block.id,
        depth: Math.max(0, block.depth - sourceDepth),
        kind: block.kind,
        text: block.text,
        level: block.level,
        checked: block.checked,
        icon: block.icon,
        ordinal: block.ordinal ?? null,
        lockedBy: block.lockedBy,
      }] : [];
    }),
  };
}
