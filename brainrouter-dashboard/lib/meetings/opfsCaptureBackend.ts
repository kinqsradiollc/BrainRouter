/**
 * ADR-035 D1b — the Origin Private File System backend: real, quota-backed file
 * writes, one file per chunk.
 *
 * This is the browser's closest analogue to D1's disk append, so it is the first
 * choice. It owns nothing but byte movement: every decision about sequences,
 * ordering, recovery and quota lives in `captureStore.ts`, because nothing in
 * this file can be executed by the test runner and untestable code should be as
 * close to none as it can be.
 *
 * One file per chunk rather than one growing file per session, for a reason the
 * ADR cares about: a write interrupted by a crash damages exactly the chunk it
 * was writing, and every earlier chunk stays a complete, readable file. Appending
 * into a single file would put the whole recording behind one truncated write.
 *
 * `createWritable` is used rather than `createSyncAccessHandle` because the
 * latter is worker-only, and the recorder runs on the main thread. The handle is
 * closed per chunk, which is what makes the bytes durable at the moment
 * `writeChunk` resolves — the store's whole promise depends on that being true.
 */
import {
  CAPTURE_MANIFEST_NAME,
  captureChunkKey,
  captureChunkSequence,
  type CaptureChunkRef,
  type CaptureManifest,
  type CaptureStorageBackend,
} from "./captureStorage";

/** One directory under the origin's root, so meeting audio is never mixed with anything else. */
const CAPTURE_ROOT_DIRECTORY = "brainrouter-meetings";

/** Written and removed once at open, to prove the API is usable and not merely present. */
const PROBE_NAME = ".capture-probe";

export function isOpfsAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

/**
 * Open the capture root, proving on the way that this browser can actually write
 * to it.
 *
 * The probe is not defensive decoration: several browsers expose
 * `navigator.storage.getDirectory` and then fail on the first write (private
 * windows, older Safari without `createWritable`). Discovering that at Stop is
 * precisely the silent loss this ADR exists to end, so it is discovered at open,
 * where the caller can still fall back to IndexedDB.
 */
export async function createOpfsCaptureBackend(): Promise<CaptureStorageBackend> {
  if (!isOpfsAvailable()) throw new Error("This browser does not provide the Origin Private File System.");
  const origin = await navigator.storage.getDirectory();
  const root = await origin.getDirectoryHandle(CAPTURE_ROOT_DIRECTORY, { create: true });
  const probe = await root.getFileHandle(PROBE_NAME, { create: true });
  if (typeof probe.createWritable !== "function") {
    await root.removeEntry(PROBE_NAME).catch(() => {});
    throw new Error("This browser's Origin Private File System cannot be written from the page.");
  }
  const writable = await probe.createWritable();
  await writable.write(new Blob([new Uint8Array([0])]));
  await writable.close();
  await root.removeEntry(PROBE_NAME);
  return new OpfsCaptureBackend(root);
}

class OpfsCaptureBackend implements CaptureStorageBackend {
  readonly kind = "opfs" as const;

  readonly #root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.#root = root;
  }

  async writeChunk(sessionId: string, sequence: number, bytes: Blob): Promise<void> {
    const directory = await this.#session(sessionId);
    const handle = await directory.getFileHandle(captureChunkKey(sequence), { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
    } catch (caught) {
      // Abort rather than close: closing would commit a partial file that
      // `listChunks` would then report as real audio.
      await writable.abort().catch(() => {});
      throw caught;
    }
    await writable.close();
  }

  async readChunk(sessionId: string, sequence: number): Promise<Blob | undefined> {
    const directory = await this.#existing(sessionId);
    if (!directory) return undefined;
    try {
      const handle = await directory.getFileHandle(captureChunkKey(sequence));
      return await handle.getFile();
    } catch {
      return undefined;
    }
  }

  async listChunks(sessionId: string): Promise<readonly CaptureChunkRef[]> {
    const directory = await this.#existing(sessionId);
    if (!directory) return [];
    const chunks: CaptureChunkRef[] = [];
    for await (const [name, handle] of directory.entries()) {
      const sequence = captureChunkSequence(name);
      if (sequence === undefined || handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      chunks.push({ sequence, byteLength: file.size });
    }
    return chunks;
  }

  async writeManifest(sessionId: string, manifest: CaptureManifest): Promise<void> {
    const directory = await this.#session(sessionId);
    const handle = await directory.getFileHandle(CAPTURE_MANIFEST_NAME, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Blob([JSON.stringify(manifest)], { type: "application/json" }));
    await writable.close();
  }

  async readManifest(sessionId: string): Promise<CaptureManifest | undefined> {
    const directory = await this.#existing(sessionId);
    if (!directory) return undefined;
    try {
      const handle = await directory.getFileHandle(CAPTURE_MANIFEST_NAME);
      const text = await (await handle.getFile()).text();
      return parseManifest(text);
    } catch {
      return undefined;
    }
  }

  async listSessionIds(): Promise<readonly string[]> {
    const ids: string[] = [];
    for await (const [name, handle] of this.#root.entries()) {
      if (handle.kind === "directory") ids.push(name);
    }
    return ids;
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.#root.removeEntry(sessionId, { recursive: true });
    } catch {
      // Already gone. D6 asks for a real deletion, and absence satisfies it.
    }
  }

  #session(sessionId: string): Promise<FileSystemDirectoryHandle> {
    return this.#root.getDirectoryHandle(sessionId, { create: true });
  }

  /** Read paths never create a directory — a listing must not invent a session. */
  async #existing(sessionId: string): Promise<FileSystemDirectoryHandle | undefined> {
    try {
      return await this.#root.getDirectoryHandle(sessionId);
    } catch {
      return undefined;
    }
  }
}

/**
 * A manifest that will not parse is treated as absent rather than as a crash: a
 * torn 200-byte JSON write must not make the megabytes of audio beside it
 * unreachable.
 */
function parseManifest(text: string): CaptureManifest | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<CaptureManifest>;
    if (typeof parsed?.startedAt !== "string") return undefined;
    return {
      startedAt: parsed.startedAt,
      closed: parsed.closed === true,
      payload: typeof parsed.payload === "string" ? parsed.payload : "",
    };
  } catch {
    return undefined;
  }
}
