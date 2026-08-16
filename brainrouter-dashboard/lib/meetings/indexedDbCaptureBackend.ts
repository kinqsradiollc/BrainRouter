/**
 * ADR-035 D1b — the IndexedDB fallback, for browsers with no usable OPFS.
 *
 * Same promise, smaller mechanism: chunks are stored as blobs keyed by
 * `[sessionId, sequence]` and the manifest is one small record keyed by session.
 * Like the OPFS backend this holds no policy — it is byte movement behind the
 * `CaptureStorageBackend` seam so that `captureStore.ts` can be the only place
 * with decisions in it.
 *
 * The chosen key path is what makes this cheap: a compound primary key means a
 * session's chunks are a contiguous range, so listing and deleting a meeting are
 * range operations rather than a scan of every recording the origin ever held.
 *
 * `IDBTransaction` auto-commits when the microtask queue drains, so every
 * operation here opens its own transaction and resolves on `oncomplete` — not on
 * `onsuccess`. The difference matters exactly once: `writeChunk` must not resolve
 * until the write is committed, because the store's caller treats that resolution
 * as "this audio now survives the tab".
 */
import {
  captureManifestChunkMs,
  type CaptureChunkRef,
  type CaptureManifest,
  type CaptureManifestRead,
  type CaptureStorageBackend,
} from "./captureStorage";

const DATABASE_NAME = "brainrouter-meetings";
const DATABASE_VERSION = 1;
const CHUNK_STORE = "chunks";
const MANIFEST_STORE = "manifests";

interface ChunkRow {
  readonly sessionId: string;
  readonly sequence: number;
  readonly byteLength: number;
  readonly blob: Blob;
}

interface ManifestRow extends CaptureManifest {
  readonly sessionId: string;
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

/**
 * Open the database, which is also the capability test: a private window that
 * exposes `indexedDB` and then refuses to open it fails here, at a point where
 * the caller can still report that no durable store is available — rather than
 * at Stop, with an hour of audio riding on it.
 */
export async function createIndexedDbCaptureBackend(): Promise<CaptureStorageBackend> {
  if (!isIndexedDbAvailable()) throw new Error("This browser does not provide IndexedDB.");
  const database = await openDatabase();
  return new IndexedDbCaptureBackend(database);
}

class IndexedDbCaptureBackend implements CaptureStorageBackend {
  readonly kind = "indexeddb" as const;

  readonly #database: IDBDatabase;

  constructor(database: IDBDatabase) {
    this.#database = database;
  }

  async writeChunk(sessionId: string, sequence: number, bytes: Blob): Promise<void> {
    const row: ChunkRow = { sessionId, sequence, byteLength: bytes.size, blob: bytes };
    await this.#commit(CHUNK_STORE, "readwrite", (store) => store.put(row));
  }

  async readChunk(sessionId: string, sequence: number): Promise<Blob | undefined> {
    const row = await this.#request<ChunkRow | undefined>(CHUNK_STORE, "readonly", (store) =>
      store.get([sessionId, sequence]),
    );
    return row?.blob;
  }

  async listChunks(sessionId: string): Promise<readonly CaptureChunkRef[]> {
    // One range read, and `byteLength` is read off the row rather than the blob:
    // a Blob retrieved from IndexedDB is a lazy handle, and asking it for bytes
    // is what would pull an hour of audio back into the heap.
    const rows = await this.#request<ChunkRow[]>(CHUNK_STORE, "readonly", (store) =>
      store.getAll(sessionRange(sessionId)),
    );
    return rows
      .filter((row) => Number.isInteger(row.sequence))
      .map((row) => ({ sequence: row.sequence, byteLength: row.byteLength }));
  }

  async writeManifest(sessionId: string, manifest: CaptureManifest): Promise<void> {
    const row: ManifestRow = { sessionId, ...manifest };
    await this.#commit(MANIFEST_STORE, "readwrite", (store) => store.put(row));
  }

  async readManifest(sessionId: string): Promise<CaptureManifestRead> {
    let row: ManifestRow | undefined;
    try {
      row = await this.#request<ManifestRow | undefined>(MANIFEST_STORE, "readonly", (store) =>
        store.get(sessionId),
      );
    } catch {
      // A row that cannot currently be read is not evidence that it never
      // existed. Classifying it as absent lets the reap delete audio that may
      // still be the only recoverable copy of a meeting.
      return { state: "corrupt" };
    }
    if (!row) return { state: "absent" };
    if (typeof row.startedAt !== "string") return { state: "corrupt" };
    const chunkMs = captureManifestChunkMs(row.chunkMs);
    return {
      state: "present",
      manifest: {
        startedAt: row.startedAt,
        closed: row.closed === true,
        payload: typeof row.payload === "string" ? row.payload : "",
        ...(chunkMs === undefined ? {} : { chunkMs }),
      },
    };
  }

  async listSessionIds(): Promise<readonly string[]> {
    // The union of both stores, so audio whose manifest never landed is still
    // discoverable — otherwise it would be unreachable bytes consuming quota.
    const manifestKeys = await this.#request<IDBValidKey[]>(MANIFEST_STORE, "readonly", (store) => store.getAllKeys());
    const chunkKeys = await this.#request<IDBValidKey[]>(CHUNK_STORE, "readonly", (store) => store.getAllKeys());
    const ids = new Set<string>();
    for (const key of manifestKeys) if (typeof key === "string") ids.add(key);
    for (const key of chunkKeys) if (Array.isArray(key) && typeof key[0] === "string") ids.add(key[0]);
    return [...ids];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#commit(CHUNK_STORE, "readwrite", (store) => store.delete(sessionRange(sessionId)));
    await this.#commit(MANIFEST_STORE, "readwrite", (store) => store.delete(sessionId));
  }

  /** Resolves on transaction COMMIT — the point at which the bytes are durable. */
  #commit(name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.#database.transaction(name, mode);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("The capture write was aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("The capture write failed."));
      run(transaction.objectStore(name));
    });
  }

  #request<T>(name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = this.#database.transaction(name, mode);
      const request = run(transaction.objectStore(name));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error("The capture read failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("The capture read was aborted."));
    });
  }
}

function sessionRange(sessionId: string): IDBKeyRange {
  // Upper bound is the largest integer sequence a chunk key can hold; the store
  // refuses anything above `MAX_CAPTURE_CHUNK_SEQUENCE` long before this.
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        database.createObjectStore(CHUNK_STORE, { keyPath: ["sessionId", "sequence"] });
      }
      if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
        database.createObjectStore(MANIFEST_STORE, { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab of this site."));
  });
}
