/**
 * ADR-035 D1b — the quota half of the browser's durability promise.
 *
 * OPFS and IndexedDB are bounded and evictable, and the ADR is blunt about what
 * that means: "an eviction discovered at Stop is the same silent loss this ADR
 * exists to end". So this module owns two things and neither of them touches a
 * browser API:
 *
 * - `ensureCapturePersistence` — ask the origin to become non-evictable, and
 *   report honestly when the answer is no. Taken as a seam because
 *   `navigator.storage` does not exist in the test runner and a persistence
 *   request that is only ever exercised by its own mock proves nothing.
 * - `evaluateCaptureBudget` — turn a raw `{usage, quota}` estimate into a level
 *   and a sentence, BEFORE the space runs out.
 *
 * The second one is the reason this is arithmetic rather than a percentage read
 * off a bar. A user does not know whether 400 MB is a lot; they know whether
 * "about 6 more minutes" is enough for the meeting they are in. So when the
 * caller can say how fast it is writing, the budget is expressed in TIME, and
 * the warning fires while the recording can still be saved rather than at the
 * moment it cannot be continued.
 *
 * A level of `unknown` is a real answer, not a missing one: a browser that will
 * not report its budget cannot promise a long recording, and golden rule 23 says
 * that degradation has to be visible.
 */

export type CaptureBudgetLevel = "unknown" | "ok" | "approaching" | "critical" | "exhausted";

/** Fraction of the origin's quota in use before the user is told anything. */
export const CAPTURE_BUDGET_APPROACHING_FRACTION = 0.8;
export const CAPTURE_BUDGET_CRITICAL_FRACTION = 0.95;

/**
 * Time-to-full thresholds. Ten minutes is roughly "you can finish this agenda
 * item and stop cleanly"; two minutes is "stop now" — both chosen to leave room
 * for the user to act rather than to be precise about a number they cannot use.
 */
export const CAPTURE_BUDGET_APPROACHING_MS = 10 * 60_000;
export const CAPTURE_BUDGET_CRITICAL_MS = 2 * 60_000;

export interface CaptureBudgetInput {
  readonly usageBytes?: number;
  readonly quotaBytes?: number;
  /** Whether the origin holds persistent storage; see `ensureCapturePersistence`. */
  readonly persisted: boolean;
  /** Observed write rate, if the caller has recorded long enough to have one. */
  readonly bytesPerMs?: number;
}

export interface CaptureBudget {
  readonly level: CaptureBudgetLevel;
  readonly usedBytes?: number;
  readonly quotaBytes?: number;
  readonly freeBytes?: number;
  readonly usedFraction?: number;
  /** How much longer the current recording fits, when a rate is known. */
  readonly headroomMs?: number;
  readonly persisted: boolean;
  /** Non-empty exactly when the user should be told something. */
  readonly message: string;
}

const LEVEL_RANK: Record<CaptureBudgetLevel, number> = {
  ok: 0,
  unknown: 1,
  approaching: 2,
  critical: 3,
  exhausted: 4,
};

/**
 * The rate a recorder is filling the store at, or `undefined` while there is not
 * yet enough evidence. Guessing a rate from a single 20 ms sample would make the
 * first warning arbitrary, and a warning a user learns to disbelieve is worse
 * than none.
 */
export function captureRecordingRate(byteLength: number, elapsedMs: number): number | undefined {
  if (!Number.isFinite(byteLength) || !Number.isFinite(elapsedMs)) return undefined;
  if (byteLength <= 0 || elapsedMs < 1_000) return undefined;
  return byteLength / elapsedMs;
}

export function evaluateCaptureBudget(input: CaptureBudgetInput): CaptureBudget {
  const usedBytes = finiteOrUndefined(input.usageBytes);
  const quotaBytes = finiteOrUndefined(input.quotaBytes);
  const persisted = input.persisted;

  if (usedBytes === undefined || quotaBytes === undefined || quotaBytes <= 0) {
    return {
      level: "unknown",
      persisted,
      message: persisted
        ? "This browser will not say how much storage is left, so a long recording cannot be guaranteed. Save it in parts if it runs long."
        : "This browser will not say how much storage is left and has not granted persistent storage, so a long recording could be evicted. Save it in parts if it runs long.",
    };
  }

  const freeBytes = Math.max(0, quotaBytes - usedBytes);
  const usedFraction = usedBytes / quotaBytes;
  const rate = input.bytesPerMs && input.bytesPerMs > 0 ? input.bytesPerMs : undefined;
  const headroomMs = rate === undefined ? undefined : Math.floor(freeBytes / rate);

  let level: CaptureBudgetLevel = "ok";
  if (freeBytes <= 0) level = "exhausted";
  else {
    if (usedFraction >= CAPTURE_BUDGET_CRITICAL_FRACTION) level = worst(level, "critical");
    else if (usedFraction >= CAPTURE_BUDGET_APPROACHING_FRACTION) level = worst(level, "approaching");
    if (headroomMs !== undefined) {
      if (headroomMs <= CAPTURE_BUDGET_CRITICAL_MS) level = worst(level, "critical");
      else if (headroomMs <= CAPTURE_BUDGET_APPROACHING_MS) level = worst(level, "approaching");
    }
  }

  return {
    level,
    usedBytes,
    quotaBytes,
    freeBytes,
    usedFraction,
    ...(headroomMs === undefined ? {} : { headroomMs }),
    persisted,
    message: budgetMessage(level, freeBytes, headroomMs, persisted),
  };
}

/** A short, non-technical size. Deliberately coarse — this appears mid-sentence. */
export function formatCaptureBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The persistence seam.
 *
 * Optional members because a browser may implement `estimate` and neither of
 * these, and because this is precisely the shape a test can hand over without
 * pretending to be a whole browser.
 */
export interface StoragePersistenceApi {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

export interface EnsurePersistenceOptions {
  /**
   * `false` reads whether persistence was already granted without asking for it.
   *
   * Firefox prompts on a request, and a page that opens the store only to see
   * whether a crashed meeting is waiting must not put a permission doorhanger in
   * front of someone who has not asked to record anything — a prompt people
   * learn to dismiss is worse than no prompt.
   */
  readonly request?: boolean;
}

/**
 * Ask once for persistent storage and report what we got.
 *
 * Never throws: a browser that refuses, or that has no such API, must still be
 * able to record — it just records with a warning attached (`evaluateCaptureBudget`
 * says so in words). Failing the recording because permission was declined would
 * be choosing no audio over evictable audio.
 */
export async function ensureCapturePersistence(
  api: StoragePersistenceApi | undefined,
  options: EnsurePersistenceOptions = {},
): Promise<boolean> {
  if (!api) return false;
  try {
    if (typeof api.persisted === "function" && (await api.persisted())) return true;
    if (options.request === false || typeof api.persist !== "function") return false;
    return (await api.persist()) === true;
  } catch {
    // A rejected persistence request tells us the answer is "no", which is
    // already the fallback value — there is nothing to escalate.
    return false;
  }
}

function worst(current: CaptureBudgetLevel, candidate: CaptureBudgetLevel): CaptureBudgetLevel {
  return LEVEL_RANK[candidate] > LEVEL_RANK[current] ? candidate : current;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function budgetMessage(
  level: CaptureBudgetLevel,
  freeBytes: number,
  headroomMs: number | undefined,
  persisted: boolean,
): string {
  const room = headroomMs === undefined
    ? `${formatCaptureBytes(freeBytes)} left`
    : `${formatCaptureBytes(freeBytes)} left — about ${formatMinutes(headroomMs)} of recording`;
  switch (level) {
    case "exhausted":
      return "Storage for this site is full. Stop and save this recording now — new audio cannot be written.";
    case "critical":
      return `Storage for this site is nearly full (${room}). Stop and save this recording, or delete an unfinished one.`;
    case "approaching":
      return `Storage for this site is filling up (${room}).`;
    case "unknown":
      return "This browser will not say how much storage is left.";
    default:
      return persisted
        ? ""
        : "This browser has not granted persistent storage, so a long recording can be evicted under disk pressure.";
  }
}

function formatMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 2) return `${minutes} minutes`;
  const seconds = Math.max(0, Math.round(ms / 1_000));
  return seconds >= 60 ? "1 minute" : `${seconds} seconds`;
}
