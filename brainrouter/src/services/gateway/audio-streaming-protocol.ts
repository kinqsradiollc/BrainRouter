/**
 * ADR-035 D10 — BrainRouter's normalized persistent-transcription wire contract.
 *
 * This module owns the gateway-facing port and the bounded frames around it. It
 * deliberately does not know any provider URL or vendor protocol: the shipped
 * speech sidecar is batch-only, so a streaming adapter must be injected only
 * after it can prove the complete normalized capability contract.
 *
 * Credentials end at gateway authentication. The injected port receives the
 * authenticated identity and immutable meeting metadata, never the bearer that
 * established them. Each connection bootstraps the media container before
 * sending structured durability chunks. A chunk carries its D9 sequence and
 * elapsed range beside bytes already written by a host; no gateway clock
 * invents that range.
 */
import type {
  MeetingStreamingTranscriptEvent,
  MeetingTranscriptionCoverageEvent,
  MeetingTranscriptionFinalEvent,
  MeetingTranscriptionLatencyMode,
  MeetingTranscriptionPartialEvent,
  MeetingTranscriptionStreamChunk,
  MeetingTranscriptionStreamInitialization,
} from "@kinqs/brainrouter-core/meetings";

import type { GatewayAuthContext } from "./auth.js";

export const GATEWAY_AUDIO_STREAM_PATH = "/v1/audio/transcriptions/stream";

export const GATEWAY_AUDIO_STREAM_CLOSE = {
  authentication: 4401,
  unavailable: 1013,
  attachTimeout: 4408,
  sessionConflict: 4409,
  protocol: 1002,
  invalidRequest: 1008,
  tooLarge: 1009,
  overloaded: 1013,
  upstreamFailure: 1011,
} as const;

export interface GatewayAudioStreamOwner {
  readonly orgId: string;
  /** Includes the principal kind so a user id cannot alias a service id. */
  readonly principalId: string;
  readonly sessionId: string;
}

export interface GatewayAudioStreamOpenInput {
  readonly auth: GatewayAuthContext;
  readonly owner: GatewayAudioStreamOwner;
  readonly mimeType: string;
  readonly language: string | null;
  readonly latencyMode: MeetingTranscriptionLatencyMode;
  /** A request only; the adapter's accepted checkpoint is authoritative. */
  readonly requestedResumeFromSequence: number | null;
  readonly signal: AbortSignal;
}

export type GatewayAudioStreamCloseReason = "transport-drop" | "finished" | "shutdown";

export type GatewayAudioChunkFrame = MeetingTranscriptionStreamChunk;
export type GatewayAudioStreamInitialization = MeetingTranscriptionStreamInitialization;

export interface GatewayAudioStreamSession {
  /**
   * This session is bound to the accepted generation. Every method MUST fence
   * its work to that generation so a late send/close cannot affect a newer open
   * for the same owner.
   */
  initialize(input: GatewayAudioStreamInitialization): Promise<void> | void;
  send(chunk: GatewayAudioChunkFrame): Promise<void> | void;
  /** Deliberate end-of-audio, distinct from a resumable transport drop. */
  finish(): Promise<void> | void;
  close(reason: GatewayAudioStreamCloseReason): Promise<void> | void;
}

export interface GatewayAudioStreamAcceptedState {
  readonly owner: GatewayAudioStreamOwner;
  readonly generation: string;
  readonly acceptedResumeFromSequence: number | null;
}

export interface GatewayAudioStreamOpenResult {
  readonly session: GatewayAudioStreamSession;
  readonly accepted: GatewayAudioStreamAcceptedState;
}

export type GatewayAudioTranscriptPartial = MeetingTranscriptionPartialEvent;
export type GatewayAudioTranscriptFinal = MeetingTranscriptionFinalEvent;
export type GatewayAudioTranscriptCoverage = MeetingTranscriptionCoverageEvent;

export interface GatewayAudioStreamHandlers {
  onEvent(event: MeetingStreamingTranscriptEvent): void;
  /** Upstream detail is intentionally absent so no adapter error can escape. */
  onDrop(): void;
}

/** Fixed refusal for a persisted owner/generation conflict; carries no adapter detail. */
export class GatewayAudioStreamConflictError extends Error {
  constructor() {
    super("The streaming transcription session cannot be resumed by this owner.");
    this.name = "GatewayAudioStreamConflictError";
  }
}

/**
 * Optional adapter seam. Production has no implementation until an upstream
 * provides a documented persistent protocol satisfying every capability.
 */
export interface GatewayAudioStreamingPort {
  capabilities(auth: GatewayAuthContext): Promise<unknown> | unknown;
  open(
    input: GatewayAudioStreamOpenInput,
    handlers: GatewayAudioStreamHandlers,
  ): Promise<GatewayAudioStreamOpenResult> | GatewayAudioStreamOpenResult;
}

export interface GatewayAudioAttachFrame {
  readonly bearer: string;
  readonly requestedOrgId: string;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly language: string | null;
  readonly latencyMode: string;
  readonly resumeFromSequence: number | null;
}

const ATTACH_KEYS = new Set([
  "type",
  "bearer",
  "requestedOrgId",
  "sessionId",
  "mimeType",
  "language",
  "latencyMode",
  "resumeFromSequence",
]);
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ORG_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LANGUAGE_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const MIME_TOKEN_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;
const CODEC_VALUE_SHAPE = /^[A-Za-z0-9._,+-]{1,64}$/;
const MAX_BEARER_CHARS = 8_192;
const MAX_ATTACH_CHARS = 16_384;
const MAX_TRANSCRIPT_CHARS = 64_000;
const GENERATION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validMimeType(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 160) return false;
  const [mediaType, ...parameters] = value.split(";").map((part) => part.trim());
  const [kind, subtype, extra] = mediaType.toLowerCase().split("/");
  if (kind !== "audio" || !subtype || extra || !MIME_TOKEN_SHAPE.test(subtype)) return false;
  return parameters.every((parameter) => {
    const separator = parameter.indexOf("=");
    if (separator <= 0) return false;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    const raw = parameter.slice(separator + 1).trim();
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return name === "codecs" && CODEC_VALUE_SHAPE.test(unquoted);
  });
}

/** Parse the credential-bearing first frame; unknown/mutable fields fail closed. */
export function parseGatewayAudioAttach(raw: string): GatewayAudioAttachFrame | null {
  if (raw.length === 0 || raw.length > MAX_ATTACH_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !ATTACH_KEYS.has(key))) return null;
  if (source.type !== "attach") return null;
  if (typeof source.bearer !== "string" || source.bearer.length === 0 || source.bearer.length > MAX_BEARER_CHARS) {
    return null;
  }
  if (typeof source.sessionId !== "string" || !SESSION_ID_SHAPE.test(source.sessionId)) return null;
  if (!validMimeType(source.mimeType)) return null;
  if (typeof source.latencyMode !== "string" || source.latencyMode.length === 0 || source.latencyMode.length > 32) {
    return null;
  }
  if (typeof source.requestedOrgId !== "string" || !ORG_ID_SHAPE.test(source.requestedOrgId)) return null;
  const language =
    source.language === undefined || source.language === null
      ? null
      : typeof source.language === "string" && LANGUAGE_SHAPE.test(source.language)
        ? source.language
        : undefined;
  if (language === undefined) return null;
  let resumeFromSequence: number | null = null;
  if (source.resumeFromSequence !== undefined && source.resumeFromSequence !== null) {
    if (
      typeof source.resumeFromSequence !== "number" ||
      !Number.isSafeInteger(source.resumeFromSequence) ||
      source.resumeFromSequence < 0 ||
      source.resumeFromSequence > 0xffff_ffff
    ) {
      return null;
    }
    resumeFromSequence = source.resumeFromSequence;
  }
  return {
    bearer: source.bearer,
    requestedOrgId: source.requestedOrgId,
    sessionId: source.sessionId,
    mimeType: source.mimeType,
    language,
    latencyMode: source.latencyMode,
    resumeFromSequence,
  };
}

export interface GatewayAudioBinaryFrame {
  readonly kind: "audio";
  readonly sequence: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly audio: Uint8Array;
}

export interface GatewayAudioInitializationFrame {
  readonly kind: "initialization";
  readonly initialization: Uint8Array;
}

export type GatewayAudioClientBinaryFrame = GatewayAudioInitializationFrame | GatewayAudioBinaryFrame;

const INITIALIZATION_FRAME_KIND = 0x01;
const AUDIO_FRAME_KIND = 0x02;
const AUDIO_FRAME_HEADER_BYTES = 1 + 4 + 8 + 8;

/**
 * Parse one explicit binary frame:
 * - 0x01 + container initialization bytes (an empty prefix remains explicit)
 * - 0x02 + u32 sequence + u64 startMs + u64 endMs + non-empty audio bytes
 */
export function parseGatewayAudioBinaryFrame(bytes: Uint8Array): GatewayAudioClientBinaryFrame | null {
  if (bytes.byteLength < 1) return null;
  if (bytes[0] === INITIALIZATION_FRAME_KIND) {
    return { kind: "initialization", initialization: bytes.subarray(1) };
  }
  if (bytes[0] !== AUDIO_FRAME_KIND || bytes.byteLength <= AUDIO_FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = view.getBigUint64(5, false);
  const end = view.getBigUint64(13, false);
  if (start > BigInt(Number.MAX_SAFE_INTEGER) || end > BigInt(Number.MAX_SAFE_INTEGER) || end <= start) return null;
  return {
    kind: "audio",
    sequence: view.getUint32(1, false),
    startMs: Number(start),
    endMs: Number(end),
    audio: bytes.subarray(AUDIO_FRAME_HEADER_BYTES),
  };
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key): key is string => typeof key === "string") &&
    expected.every((key) => keys.includes(key))
  );
}

function validCanonicalBase(value: {
  readonly utteranceId: string;
  readonly revision: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}): boolean {
  return (
    value.utteranceId.trim().length > 0 &&
    value.utteranceId.length <= 128 &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    value.text.length <= MAX_TRANSCRIPT_CHARS &&
    Number.isFinite(value.startMs) &&
    value.startMs >= 0 &&
    Number.isFinite(value.endMs) &&
    value.endMs > value.startMs
  );
}

/**
 * Read every adapter property once into a frozen plain object before validation
 * or serialization. Getter-backed and subsequently mutated objects therefore
 * cannot change the event after the gateway has accepted it.
 */
export function canonicalizeGatewayAudioEvent(
  value: unknown,
): GatewayAudioTranscriptPartial | GatewayAudioTranscriptFinal | GatewayAudioTranscriptCoverage | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const kind = source.kind;
    if (kind === "coverage") {
      if (!exactKeys(source, ["kind", "coveredThroughSequence"])) return null;
      const coveredThroughSequence = source.coveredThroughSequence;
      if (
        typeof coveredThroughSequence !== "number" ||
        !Number.isSafeInteger(coveredThroughSequence) ||
        coveredThroughSequence < 0 ||
        coveredThroughSequence >= 0xffff_ffff
      )
        return null;
      return Object.freeze({ kind, coveredThroughSequence });
    }
    const expected =
      kind === "partial"
        ? ["kind", "utteranceId", "revision", "text", "startMs", "endMs"]
        : kind === "final"
          ? ["kind", "utteranceId", "revision", "text", "startMs", "endMs"]
          : null;
    if (!expected || !exactKeys(source, expected)) return null;

    const utteranceId = source.utteranceId;
    const revision = source.revision;
    const text = source.text;
    const startMs = source.startMs;
    const endMs = source.endMs;
    if (
      typeof utteranceId !== "string" ||
      typeof revision !== "number" ||
      typeof text !== "string" ||
      typeof startMs !== "number" ||
      typeof endMs !== "number"
    ) {
      return null;
    }
    const base = { utteranceId, revision, text, startMs, endMs };
    if (kind === "partial") {
      const event = Object.freeze({ kind: "partial", ...base }) satisfies GatewayAudioTranscriptPartial;
      return validCanonicalBase(event) ? event : null;
    }
    const event = Object.freeze({ kind: "final", ...base }) satisfies GatewayAudioTranscriptFinal;
    return validCanonicalBase(event) ? event : null;
  } catch {
    return null;
  }
}

/** Canonicalize the adapter's authoritative owner/generation/checkpoint once. */
export function canonicalizeGatewayAudioOpenResult(
  value: unknown,
  expectedOwner: GatewayAudioStreamOwner,
): GatewayAudioStreamOpenResult | null {
  try {
    if (!value || typeof value !== "object" || !exactKeys(value, ["session", "accepted"])) return null;
    const source = value as Record<string, unknown>;
    const rawSession = source.session;
    const rawAccepted = source.accepted;
    if (!rawSession || typeof rawSession !== "object" || !rawAccepted || typeof rawAccepted !== "object") return null;
    if (!exactKeys(rawAccepted, ["owner", "generation", "acceptedResumeFromSequence"])) return null;
    const accepted = rawAccepted as Record<string, unknown>;
    const rawOwner = accepted.owner;
    const generation = accepted.generation;
    const checkpoint = accepted.acceptedResumeFromSequence;
    if (!rawOwner || typeof rawOwner !== "object" || !exactKeys(rawOwner, ["orgId", "principalId", "sessionId"])) {
      return null;
    }
    const owner = rawOwner as Record<string, unknown>;
    if (
      owner.orgId !== expectedOwner.orgId ||
      owner.principalId !== expectedOwner.principalId ||
      owner.sessionId !== expectedOwner.sessionId ||
      typeof generation !== "string" ||
      !GENERATION_SHAPE.test(generation) ||
      (checkpoint !== null &&
        (typeof checkpoint !== "number" ||
          !Number.isSafeInteger(checkpoint) ||
          checkpoint < 0 ||
          // 0xffffffff has no representable next u32 audio sequence.
          checkpoint >= 0xffff_ffff))
    ) {
      return null;
    }
    const sessionSource = rawSession as Record<string, unknown>;
    const initialize = sessionSource.initialize;
    const send = sessionSource.send;
    const finish = sessionSource.finish;
    const close = sessionSource.close;
    if (
      typeof initialize !== "function" ||
      typeof send !== "function" ||
      typeof finish !== "function" ||
      typeof close !== "function"
    )
      return null;
    const session: GatewayAudioStreamSession = Object.freeze({
      initialize: (input: GatewayAudioStreamInitialization) => Reflect.apply(initialize, rawSession, [input]),
      send: (chunk: GatewayAudioChunkFrame) => Reflect.apply(send, rawSession, [chunk]),
      finish: () => Reflect.apply(finish, rawSession, []),
      close: (reason: GatewayAudioStreamCloseReason) => Reflect.apply(close, rawSession, [reason]),
    });
    return Object.freeze({
      session,
      accepted: Object.freeze({
        owner: expectedOwner,
        generation,
        acceptedResumeFromSequence: checkpoint as number | null,
      }),
    });
  } catch {
    return null;
  }
}
