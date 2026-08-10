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

  constructor(options: FakeCaptureBackendOptions = {}) {
    this.kind = options.kind ?? "opfs";
    this.#shuffleListing = options.shuffleListing === true;
  }

  async writeChunk(sessionId: string, sequence: number, bytes: Blob): Promise<void> {
    const key = `${sessionId}:${sequence}`;
    this.calls.push(`writeChunk:${key}`);
    if (this.failWrites.delete(key)) throw new Error(`refused ${key}`);
    this.chunks.set(key, bytes);
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
    this.manifests.set(sessionId, manifest);
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
    this.manifests.delete(sessionId);
    for (const key of [...this.chunks.keys()]) {
      if (splitKey(key)[0] === sessionId) this.chunks.delete(key);
    }
  }
}

function splitKey(key: string): [string, number] {
  const separator = key.lastIndexOf(":");
  return [key.slice(0, separator), Number(key.slice(separator + 1))];
}

/** A blob of `size` deterministic bytes, so a reassembled recording can be checked byte for byte. */
export function audioBlob(size: number, fill: number): Blob {
  return new Blob([new Uint8Array(size).fill(fill)]);
}
