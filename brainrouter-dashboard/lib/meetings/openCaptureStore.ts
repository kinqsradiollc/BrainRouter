/**
 * ADR-035 D1b — choosing a durable store, and saying which one we got.
 *
 * This module owns the fallback ladder: OPFS first, IndexedDB second, and an
 * error rather than a silent memory-only recording if neither can be opened.
 * The ladder itself (`firstUsableCaptureBackend`) is pure and takes candidates
 * as arguments, because it is the part with a decision in it — which candidate
 * wins, what happens when the first one throws, and what a caller is told when
 * they all do. The browser-specific candidate list is a two-line function
 * underneath it.
 *
 * Every attempt that failed is kept and returned. Golden rule 23: a fallback has
 * to be visible or it is a silent outage, and "your meeting was stored in the
 * slower fallback because OPFS threw" is a sentence someone will need when a
 * recording behaves oddly six weeks from now.
 *
 * Opening a store never falls back to memory. A memory-backed capture is exactly
 * the defect ADR-035 §1 describes — `chunksRef` with a different name — so a
 * browser that can offer no durable store must fail loudly at Record, while the
 * user can still choose another browser, rather than quietly at Stop.
 */
import {
  type CaptureStorageBackend,
  type CaptureStorageKind,
  selectCaptureBackendKind,
} from "./captureStorage";
import { MeetingCaptureStore } from "./captureStore";
import { createIndexedDbCaptureBackend, isIndexedDbAvailable } from "./indexedDbCaptureBackend";
import { createOpfsCaptureBackend, isOpfsAvailable } from "./opfsCaptureBackend";
import { ensureCapturePersistence, type StoragePersistenceApi } from "./storageBudget";

export interface CaptureBackendCandidate {
  readonly kind: CaptureStorageKind;
  create(): Promise<CaptureStorageBackend>;
}

export interface CaptureBackendAttempt {
  readonly kind: CaptureStorageKind;
  readonly error: string;
}

export interface CaptureBackendSelection {
  readonly backend: CaptureStorageBackend;
  /** Candidates that were tried and failed, in order — empty on the happy path. */
  readonly rejected: readonly CaptureBackendAttempt[];
}

/**
 * Try each candidate in order and return the first that opens.
 *
 * A candidate that *exists* is not a candidate that *works* — a private window
 * exposes both APIs and refuses both — so the ladder is driven by whether
 * `create()` resolves, not by a feature probe.
 */
export async function firstUsableCaptureBackend(
  candidates: readonly CaptureBackendCandidate[],
): Promise<CaptureBackendSelection> {
  const rejected: CaptureBackendAttempt[] = [];
  for (const candidate of candidates) {
    try {
      return { backend: await candidate.create(), rejected };
    } catch (caught) {
      rejected.push({ kind: candidate.kind, error: caught instanceof Error ? caught.message : String(caught) });
    }
  }
  const detail = rejected.map((attempt) => `${attempt.kind}: ${attempt.error}`).join("; ");
  throw new Error(
    detail
      ? `This browser has no durable place to store a recording (${detail}).`
      : "This browser has no durable place to store a recording.",
  );
}

const CAPTURE_BACKEND_FACTORIES: Record<CaptureStorageKind, () => Promise<CaptureStorageBackend>> = {
  opfs: createOpfsCaptureBackend,
  indexeddb: createIndexedDbCaptureBackend,
};

/** The candidates this browser can offer, in D1b's order. */
export function browserCaptureCandidates(): readonly CaptureBackendCandidate[] {
  const capabilities = { opfs: isOpfsAvailable(), indexedDb: isIndexedDbAvailable() };
  const preferred = selectCaptureBackendKind(capabilities);
  const order: CaptureStorageKind[] = preferred ? [preferred] : [];
  // IndexedDB is appended even when OPFS was preferred: it is the fallback for an
  // OPFS that opens and then fails, which is the case a feature probe misses.
  if (capabilities.indexedDb && !order.includes("indexeddb")) order.push("indexeddb");
  return order.map((kind) => ({ kind, create: CAPTURE_BACKEND_FACTORIES[kind] }));
}

export interface OpenCaptureStoreOptions {
  readonly candidates?: readonly CaptureBackendCandidate[];
  readonly persistence?: StoragePersistenceApi;
  readonly estimate?: () => Promise<{ usage?: number; quota?: number }>;
  /** `false` checks persistence without requesting it — see `EnsurePersistenceOptions`. */
  readonly requestPersistence?: boolean;
}

export interface OpenedCaptureStore {
  readonly store: MeetingCaptureStore;
  readonly kind: CaptureStorageKind;
  readonly persisted: boolean;
  readonly rejected: readonly CaptureBackendAttempt[];
}

/**
 * Open the store the browser can actually give us, having first asked for
 * persistent storage.
 *
 * The persistence request comes first because it is the cheap half of D1b's
 * quota obligation: an origin that has been granted persistence is not evicted
 * under disk pressure at all, and the answer is what the budget's warning
 * wording depends on.
 */
export async function openMeetingCaptureStore(options: OpenCaptureStoreOptions = {}): Promise<OpenedCaptureStore> {
  const persistence = options.persistence
    ?? (typeof navigator !== "undefined" ? (navigator.storage as StoragePersistenceApi | undefined) : undefined);
  const persisted = await ensureCapturePersistence(persistence, { request: options.requestPersistence !== false });
  const estimate = options.estimate
    ?? (typeof navigator !== "undefined" && typeof navigator.storage?.estimate === "function"
      ? () => navigator.storage.estimate()
      : undefined);
  const selection = await firstUsableCaptureBackend(options.candidates ?? browserCaptureCandidates());
  const store = new MeetingCaptureStore(selection.backend, {
    persisted,
    ...(estimate ? { estimate } : {}),
  });
  return { store, kind: store.kind, persisted, rejected: selection.rejected };
}
