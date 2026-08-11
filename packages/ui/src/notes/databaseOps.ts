/**
 * ADR-029 E3 — what a database surface can do, in two shapes.
 *
 * `DatabaseHostOps` is what the container offers: every method names the
 * database or the row it acts on, and every one of them is a call into core
 * through a host handler. Nothing here writes; `notes-database-*` composes
 * `noteStore`'s mutations, so a cell edit travels the row's own outbox and the
 * lease refuses it while another device is typing in that row — the same
 * treatment a paragraph gets.
 *
 * `DatabaseOps` is the same set BOUND to one database and one open view, which
 * is what a table cell or a filter row actually has in hand. Binding it here
 * rather than threading the id through every component is what keeps a control
 * from writing to the wrong database when a page holds two.
 */
import type { MentionCandidate } from './mentionPicker.js';
import type {
  DatabaseReadDto, NoteFileDto, NoteFilterGroup, NotePropertyValue, NoteRollupSpec,
  NoteSelectOption, NoteSortRule, NoteViewKind, PropertyCatalogDto, RollupTargetsDto,
} from './database.js';

/** F2 — what a formula or rollup column is configured with. */
export interface PropertyConfig {
  formula?: string;
  rollup?: NoteRollupSpec;
}

/**
 * A view written back.
 *
 * `null` on `filter` and `groupBy` is "stop doing this" and `undefined` is
 * "leave it alone" — core's `saveView` reads them that way, and collapsing the
 * two here would make clearing a filter impossible to express.
 */
export interface SaveViewInput {
  /** Absent creates a view; present replaces one. */
  viewId?: string;
  name?: string;
  kind?: NoteViewKind;
  visible?: readonly string[];
  filter?: NoteFilterGroup | null;
  sort?: readonly NoteSortRule[];
  groupBy?: string | null;
}

/** Native attachment bytes are optional for browser adapters. */
export interface DatabaseFileCapability {
  attach: (name: string, dataBase64: string) => Promise<{ ok: boolean; ref?: string; error?: string }>;
  describe: (ids: readonly string[]) => Promise<NoteFileDto[]>;
}

export interface DatabaseHostOps {
  read: (databaseId: string, viewId?: string) => Promise<DatabaseReadDto | null>;
  /** E3 — this creates a PAGE under the database. Returns its id so it can open. */
  addRow: (databaseId: string, after?: string) => Promise<string | null>;
  setValue: (rowId: string, propertyId: string, value: NotePropertyValue) => Promise<void>;
  removeRow: (rowId: string) => Promise<void>;
  addProperty: (databaseId: string, name: string, type: string, config?: PropertyConfig) => Promise<void>;
  updateProperty: (
    databaseId: string,
    propertyId: string,
    patch: { name?: string; options?: readonly NoteSelectOption[] } & PropertyConfig,
  ) => Promise<void>;
  removeProperty: (databaseId: string, propertyId: string) => Promise<void>;
  /** The whole desired order; core keeps anything the caller left out. */
  reorderProperties: (databaseId: string, order: readonly string[]) => Promise<void>;
  /**
   * The types a picker may offer, and the operators each one supports.
   *
   * Asked for rather than listed in the renderer: a surface that built its own
   * list would eventually offer a type core cannot evaluate, or an operator the
   * evaluator then reports as skipped — a filter that looks applied and is not.
   */
  propertyCatalog: () => Promise<PropertyCatalogDto | null>;
  saveView: (databaseId: string, input: SaveViewInput) => Promise<void>;
  removeView: (databaseId: string, viewId: string) => Promise<void>;
  /**
   * F2 — the columns a rollup could summarise, from where the relation POINTS.
   *
   * A picker built from a fixed list would offer a target that does not exist on
   * the other end, and every row would then report it as unreadable — the shape
   * of defect F1 exists to stop: an offer the product cannot honour.
   */
  rollupTargets: (databaseId: string, relationPropertyId: string) => Promise<RollupTargetsDto>;
  /** Omitted when this host has no attachment-byte transport. */
  files?: DatabaseFileCapability;
  /** Opening a row, a sub-page or a full-page database is the same navigation. */
  openPage: (pageId: string | null) => void;
  openRef: (uri: string) => void;
  /** E5 — what a relation can address: every mode, through the `@` picker's list. */
  searchRefs: (query: string) => Promise<MentionCandidate[]>;
}

/** The host ops with the database and the view already decided. */
export interface DatabaseOps {
  addRow: (after?: string) => Promise<string | null>;
  setValue: (rowId: string, propertyId: string, value: NotePropertyValue) => Promise<void>;
  removeRow: (rowId: string) => Promise<void>;
  addProperty: (name: string, type: string, config?: PropertyConfig) => Promise<void>;
  addOption: (propertyId: string, option: NoteSelectOption) => Promise<void>;
  /** F2 — rewrite a formula or a rollup. The values are untouched; nothing stored one. */
  configureProperty: (propertyId: string, config: PropertyConfig) => Promise<void>;
  removeProperty: (propertyId: string) => Promise<void>;
  rollupTargets: (relationPropertyId: string) => Promise<RollupTargetsDto>;
  files?: DatabaseFileCapability;
  reorderProperties: (order: readonly string[]) => Promise<void>;
  propertyCatalog: () => Promise<PropertyCatalogDto | null>;
  saveView: (input: SaveViewInput) => Promise<void>;
  removeView: (viewId: string) => Promise<void>;
  /** Which stored view is on screen. Local to this surface, not saved. */
  openView: (viewId: string) => void;
  /** E3 — a row IS a page, so this is the ordinary "open a page" navigation. */
  openRow: (rowId: string) => void;
  openDatabase: () => void;
  openRef: (uri: string) => void;
  searchRefs: (query: string) => Promise<MentionCandidate[]>;
}

export function bindDatabaseOps(
  databaseId: string,
  host: DatabaseHostOps,
  /** The read the caller already has, so an option can be appended to its list. */
  optionsOf: (propertyId: string) => readonly NoteSelectOption[],
  onView: (viewId: string) => void,
): DatabaseOps {
  return {
    addRow: (after) => host.addRow(databaseId, after),
    setValue: host.setValue,
    removeRow: host.removeRow,
    addProperty: (name, type, config) => host.addProperty(databaseId, name, type, config),
    // An option is appended to the list the schema already holds rather than
    // replacing it: `updateProperty` takes the whole `options` array, so sending
    // only the new one would delete every choice the person had made.
    addOption: (propertyId, option) => host.updateProperty(databaseId, propertyId, {
      options: [...optionsOf(propertyId), option],
    }),
    configureProperty: (propertyId, config) => host.updateProperty(databaseId, propertyId, config),
    removeProperty: (propertyId) => host.removeProperty(databaseId, propertyId),
    rollupTargets: (relationPropertyId) => host.rollupTargets(databaseId, relationPropertyId),
    files: host.files,
    reorderProperties: (order) => host.reorderProperties(databaseId, order),
    propertyCatalog: host.propertyCatalog,
    saveView: (input) => host.saveView(databaseId, input),
    removeView: (viewId) => host.removeView(databaseId, viewId),
    openView: onView,
    openRow: (rowId) => host.openPage(rowId),
    openDatabase: () => host.openPage(databaseId),
    openRef: host.openRef,
    searchRefs: host.searchRefs,
  };
}
