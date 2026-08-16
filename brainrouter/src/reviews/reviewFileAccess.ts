/**
 * ADR-033 D3/D9 — the read-only window a review is allowed to ask through.
 *
 * The checkout has been on disk since ADR-025; what this adds is the ability to
 * ask it for one more file, and the boundary that makes asking safe. The risk
 * D3 sharpens is not that an attacker gets code near us — it already is — but
 * that a hostile diff steers WHAT WE READ, by naming a path in a comment and
 * hoping the reviewer repeats it.
 *
 * So every read is answered by this module, and it can only ever say three
 * things: here is a file from the reviewed checkout, here is why you cannot
 * have that one, or the budget is spent. Concretely:
 *
 *   - the path must be repo-relative and normalised — no absolute path, no
 *     `..`, no backslash, no NUL/CR/LF;
 *   - the read itself goes through the exact-checkout adapter, which serves
 *     only inventoried paths and opens with `O_NOFOLLOW`, so a symlink planted
 *     in the branch cannot reach outside the checkout;
 *   - the access is READ-ONLY by construction — there is no write seam here to
 *     misuse, because a reviewer that can write is a different trust decision;
 *   - and it is bounded, so a request loop cannot become a crawl of the tree.
 *
 * A refused path comes back LABELLED rather than missing: a reviewer that
 * cannot tell "not there" from "not allowed" will guess, and guessing is the
 * failure this whole ADR is about.
 */

import type { ServedEvidenceFile } from "@kinqs/brainrouter-core/review";
import { normalizeReviewPath } from "@kinqs/brainrouter-core/review";
import { isSafeRepositoryRelativePath } from "./repository-context/contracts.js";
import {
  isSensitiveReviewSourcePath,
  redactReviewSourceText,
  SENSITIVE_REVIEW_SOURCE_REASON,
} from "./repository-context/source-safety.js";

/** The exact-revision checkout, as much of it as this module is allowed to use. */
export interface ReviewCheckoutReader {
  /** Resolve one inventoried text file; rejects anything else. */
  readSourceFile(path: string, maxBytes: number): Promise<string>;
}

export interface ReviewFileAccessLimits {
  /** Successful file responses one review may receive across all bundles. */
  maxFiles: number;
  /** Valid, unique path requests one review may attempt, including misses. */
  maxRequests: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

export const DEFAULT_REVIEW_FILE_ACCESS_LIMITS: ReviewFileAccessLimits = {
  maxFiles: 8,
  maxRequests: 24,
  maxBytesPerFile: 48 * 1024,
  maxTotalBytes: 128 * 1024,
};

export interface ReviewFileAccess {
  serve(paths: readonly string[], bundleId: string): Promise<ServedEvidenceFile[]>;
  /** Deterministic, non-model-facing exact source for evidence-derived lines. */
  readForPosition(path: string): Promise<string | null>;
  /** How many files this review has actually been given (for telemetry). */
  readonly filesServed: number;
}

const OUTSIDE_CHECKOUT = "not a repo-relative path inside the reviewed checkout";
const NOT_AVAILABLE = "not part of the reviewed checkout at this exact revision";
const BUDGET_SPENT = "the review's file-request budget is spent";
const TOO_LARGE = "present in the reviewed checkout, but larger than one request may return";
const ALREADY_SERVED = "already answered for this review bundle";
const MAX_POSITION_FILES = 64;
const MAX_POSITION_FILE_BYTES = 512 * 1024;

function safeRequestedPath(requested: unknown): string {
  const raw = String(requested ?? "").trim();
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return "";
  const path = normalizeReviewPath(raw);
  return path && isSafeRepositoryRelativePath(path) ? path : "";
}

/**
 * Tell "too big to serve" apart from "not there".
 *
 * The checkout adapter throws for both, and collapsing them into NOT_AVAILABLE
 * told the reviewer a file that exists does not — the precise confusion this
 * module's header says it exists to prevent. Twenty `.ts` files in this
 * repository alone are over the 48 KB per-file cap, so the miss lands on exactly
 * the big files a reviewer most wants to see. Matched on the adapter's own
 * wording rather than an error class, because the two live in different packages
 * and the message is the only contract that crosses.
 */
function unavailableReasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /read limit/i.test(message) ? TOO_LARGE : NOT_AVAILABLE;
}

export function createReviewFileAccess(
  reader: ReviewCheckoutReader,
  limits: Partial<ReviewFileAccessLimits> = {},
): ReviewFileAccess {
  const bounds: ReviewFileAccessLimits = {
    maxFiles: Math.max(1, Math.trunc(limits.maxFiles ?? DEFAULT_REVIEW_FILE_ACCESS_LIMITS.maxFiles)),
    maxRequests: Math.max(
      1,
      Math.trunc(limits.maxRequests ?? DEFAULT_REVIEW_FILE_ACCESS_LIMITS.maxRequests),
    ),
    maxBytesPerFile: Math.max(
      1_024,
      Math.trunc(limits.maxBytesPerFile ?? DEFAULT_REVIEW_FILE_ACCESS_LIMITS.maxBytesPerFile),
    ),
    maxTotalBytes: Math.max(
      1_024,
      Math.trunc(limits.maxTotalBytes ?? DEFAULT_REVIEW_FILE_ACCESS_LIMITS.maxTotalBytes),
    ),
  };
  let served = 0;
  let requests = 0;
  let bytes = 0;
  const answeredByBundle = new Map<string, Set<string>>();
  const positionReads = new Map<string, Promise<string | null>>();
  let queue: Promise<void> = Promise.resolve();

  const serveSerially = async (
    paths: readonly string[],
    bundleId: string,
  ): Promise<ServedEvidenceFile[]> => {
    const scope = String(bundleId ?? "").trim().slice(0, 200);
    if (!scope) throw new Error("Review file access requires a bundle id.");
    const answered = answeredByBundle.get(scope) ?? new Set<string>();
    answeredByBundle.set(scope, answered);
    const answers: ServedEvidenceFile[] = [];
    for (const requested of paths) {
      // An absolute path is REFUSED, never reinterpreted as repo-relative:
      // silently rebasing `/etc/passwd` onto the checkout would answer a
      // question nobody asked, and the reviewer must learn that what it named
      // is outside the review rather than that the repository lacks it.
      const path = safeRequestedPath(requested);
      if (!path) {
        answers.push({ path: String(requested).slice(0, 200), unavailableReason: OUTSIDE_CHECKOUT });
        continue;
      }
      if (answered.has(path)) {
        answers.push({ path, unavailableReason: ALREADY_SERVED });
        continue;
      }
      answered.add(path);
      if (requests >= bounds.maxRequests || served >= bounds.maxFiles || bytes >= bounds.maxTotalBytes) {
        answers.push({ path, unavailableReason: BUDGET_SPENT });
        continue;
      }
      requests += 1;
      if (isSensitiveReviewSourcePath(path)) {
        answers.push({ path, unavailableReason: SENSITIVE_REVIEW_SOURCE_REASON });
        continue;
      }
      try {
        const content = redactReviewSourceText(
          await reader.readSourceFile(path, bounds.maxBytesPerFile),
        );
        const room = Math.min(bounds.maxBytesPerFile, bounds.maxTotalBytes - bytes);
        const text = truncateUtf8(content, room);
        served += 1;
        bytes += Buffer.byteLength(text);
        answers.push({ path, content: text });
      } catch (error) {
        // The underlying error can carry a temp-directory path; the reviewer
        // gets the fact, never the filesystem.
        answers.push({ path, unavailableReason: unavailableReasonFor(error) });
      }
    }
    return answers;
  };

  return {
    get filesServed(): number {
      return served;
    },
    serve(paths: readonly string[], bundleId: string): Promise<ServedEvidenceFile[]> {
      const work = queue.then(
        () => serveSerially(paths, bundleId),
        () => serveSerially(paths, bundleId),
      );
      queue = work.then(() => undefined, () => undefined);
      return work;
    },
    readForPosition(requested: string): Promise<string | null> {
      const path = safeRequestedPath(requested);
      if (!path || isSensitiveReviewSourcePath(path)) return Promise.resolve(null);
      const cached = positionReads.get(path);
      if (cached) return cached;
      if (positionReads.size >= MAX_POSITION_FILES) return Promise.resolve(null);
      const read = reader.readSourceFile(path, MAX_POSITION_FILE_BYTES)
        .then((content) => redactReviewSourceText(content))
        .catch(() => null);
      positionReads.set(path, read);
      return read;
    },
  };
}

/** UTF-8 byte-bounded text, with the truncation label inside the same budget. */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  const marker = "\n… truncated";
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= maxBytes) return utf8Prefix(bytes, maxBytes);
  return `${utf8Prefix(bytes, maxBytes - markerBytes)}${marker}`;
}

function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.max(0, Math.min(bytes.length, maxBytes));
  // `end` is the first excluded byte. If that byte is a continuation byte,
  // the boundary fell inside a code point; walk back to its leading byte.
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}
