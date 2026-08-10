/**
 * A backend that keeps chunks in a Map, for the capture-store tests.
 *
 * This is a fixture, not a shipped fallback: `openCaptureStore.ts` deliberately
 * refuses to hand a recording to a memory-backed store, because that is the
 * exact defect ADR-035 §1 describes. It lives here so tests can drive the real
 * `MeetingCaptureStore` — the module that holds every decision — in a runner
 * that has neither OPFS nor IndexedDB.
 *
 * It records `calls` and can be told to fail a specific write, so a test can
 * assert the ORDER the store does things in and what it does when a write does
 * not land. Those are the properties D1b actually promises; a fixture that only
 * ever succeeds would let all of them regress unnoticed.
 *
 * The underscore prefix keeps it out of the `*.test.ts` glob.
 */
import type {
  CaptureChunkRef,
  CaptureManifest,
  CaptureStorageBackend,
  CaptureStorageKind,
} from "./captureStorage";

export interface FakeCaptureBackendOptions {
  readonly kind?: CaptureStorageKind;
  /** Return the order chunks should be listed in; defaults to insertion order. */
  readonly shuffleListing?: boolean;
  /**
   * Microtask ticks a `writeChunk` takes before the bytes land.
   *
   * Zero would make every write faster than every read, which is the one shape
   * that hides the defect this fixture is here to catch: OPFS needs
   * `getDirectoryHandle` → `getFileHandle` → `createWritable` → `write` →
   * `close` to store a chunk, and only `getDirectoryHandle` → `getFileHandle` →
   * `getFile` to read one. A read started after a write can therefore finish
   * first, and a store that does not queue them together loses the last chunk.
   */
  readonly writeTicks?: number;
  /**
   * Ticks a `writeManifest` takes before the record lands.
   *
   * The manifest is where the read-modify-write races live: `setPayload` reads a
   * manifest, builds the next one and writes it back, and `begin` checks for one
   * before creating it. With an instant write those pairs look atomic here and
   * are not atomic in a browser, which is exactly how a `delete` slipping
   * between the halves stayed invisible.
   */
  readonly manifestTicks?: number;
  /**
   * Ticks a `deleteSession` takes.
   *
   * `removeEntry(id, { recursive: true })` walks a directory; it is the slowest
   * thing OPFS does, not the fastest. Zero would order every delete before any
   * concurrent write by accident and hide whether the store orders them on
   * purpose.
   */
  readonly deleteTicks?: number;
}

export class FakeCaptureBackend implements CaptureStorageBackend {
  readonly kind: CaptureStorageKind;

  /** Every call, in order, as `"method:sessionId[:sequence]"`. */
  readonly calls: string[] = [];

  /** Sequences whose next write must fail, keyed `"sessionId:sequence"`. */
  readonly failWrites = new Set<string>();

  /**
   * Sequences that list but do not read, keyed `"sessionId:sequence"` — a torn
   * store, where the entry survived and its bytes did not.
   */
  readonly unreadable = new Set<string>();

  readonly chunks = new Map<string, Blob>();
  readonly manifests = new Map<string, CaptureManifest>();

  readonly #shuffleListing: boolean;

  readonly #writeTicks: number;

  readonly #manifestTicks: number;

  readonly #deleteTicks: number;

  constructor(options: FakeCaptureBackendOptions = {}) {
    this.kind = options.kind ?? "opfs";
    this.#shuffleListing = options.shuffleListing === true;
    this.#writeTicks = Math.max(0, options.writeTicks ?? 0);
    this.#manifestTicks = Math.max(0, options.manifestTicks ?? 0);
    this.#deleteTicks = Math.max(0, options.deleteTicks ?? 0);
  }

  async writeChunk(sessionId: string, sequence: number, bytes: Blob): Promise<void> {
    const key = `${sessionId}:${sequence}`;
    this.calls.push(`writeChunk:${key}`);
    // The ticks are spent BEFORE the failure and before the bytes land, so a
    // slow backend is slow on both paths, as a real one is.
    await spend(this.#writeTicks);
    if (this.failWrites.delete(key)) throw new Error(`refused ${key}`);
    this.chunks.set(key, bytes);
    this.calls.push(`wrote:${key}`);
  }

  async readChunk(sessionId: string, sequence: number): Promise<Blob | undefined> {
    const key = `${sessionId}:${sequence}`;
    this.calls.push(`readChunk:${key}`);
    return this.unreadable.has(key) ? undefined : this.chunks.get(key);
  }

  async listChunks(sessionId: string): Promise<readonly CaptureChunkRef[]> {
    this.calls.push(`listChunks:${sessionId}`);
    const refs: CaptureChunkRef[] = [];
    for (const [key, blob] of this.chunks) {
      const [id, sequence] = splitKey(key);
      if (id === sessionId) refs.push({ sequence, byteLength: blob.size });
    }
    return this.#shuffleListing ? refs.reverse() : refs;
  }

  async writeManifest(sessionId: string, manifest: CaptureManifest): Promise<void> {
    this.calls.push(`writeManifest:${sessionId}`);
    await spend(this.#manifestTicks);
    this.manifests.set(sessionId, manifest);
    this.calls.push(`wroteManifest:${sessionId}`);
  }

  async readManifest(sessionId: string): Promise<CaptureManifest | undefined> {
    this.calls.push(`readManifest:${sessionId}`);
    return this.manifests.get(sessionId);
  }

  async listSessionIds(): Promise<readonly string[]> {
    this.calls.push("listSessionIds");
    const ids = new Set<string>(this.manifests.keys());
    for (const key of this.chunks.keys()) ids.add(splitKey(key)[0]);
    return [...ids];
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.calls.push(`deleteSession:${sessionId}`);
    await spend(this.#deleteTicks);
    this.manifests.delete(sessionId);
    for (const key of [...this.chunks.keys()]) {
      if (splitKey(key)[0] === sessionId) this.chunks.delete(key);
    }
  }
}

/** Burn `ticks` microtasks, so an operation can be slower than another one. */
async function spend(ticks: number): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
}

function splitKey(key: string): [string, number] {
  const separator = key.lastIndexOf(":");
  return [key.slice(0, separator), Number(key.slice(separator + 1))];
}

/** A blob of `size` deterministic bytes, so a reassembled recording can be checked byte for byte. */
export function audioBlob(size: number, fill: number): Blob {
  return new Blob([new Uint8Array(size).fill(fill)]);
}
