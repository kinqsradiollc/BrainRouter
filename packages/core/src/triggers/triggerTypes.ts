/**
 * MC-B1 — trigger ingress: the neutral event model + the provider port.
 *
 * External automation events (webhooks) enter BrainRouter through exactly one
 * seam: a provider adapter that (1) proves the delivery came from the
 * configured counterpart via a shared-secret signature and (2) reduces the
 * provider payload to a small neutral `TriggerEvent`. Everything downstream
 * (resolvers, fleet jobs, PR delivery) consumes only the neutral shape, so
 * adding a provider later never touches the pipeline.
 *
 * Security posture (deliberate, fail-closed):
 * - Signature verification is MANDATORY. A provider with no configured secret
 *   rejects every delivery — an unset knob can never mean "skip the check".
 * - Comparison is timing-safe (`crypto.timingSafeEqual`) over equal-length
 *   digests, never string equality.
 * - The raw payload is persisted bounded + secret-redacted; the neutral event
 *   carries only a `payloadRef` pointer, never the raw body.
 */

/**
 * Neutral event kinds the resolvers understand. Providers map their native
 * event/action pairs onto these; unmapped-but-valid deliveries keep a
 * `<event>.<action>` shape (the open string arm) so a resolver can opt into
 * kinds we haven't named yet without a schema change.
 */
export type TriggerEventKind =
  | 'issue.opened'
  | 'issue.labeled'
  | 'comment.created'
  | 'review.comment'
  | 'pull_request.opened'
  | 'pull_request.labeled'
  | 'workflow_run.completed'
  | 'ping'
  | (string & {});

/** The neutral, provider-agnostic event handed to sinks/resolvers. */
export interface TriggerEvent {
  /** Registry name of the provider adapter that produced this event. */
  provider: string;
  /** Normalized `<noun>.<action>` kind (see `TriggerEventKind`). */
  kind: TriggerEventKind;
  /** `owner/name` repository slug, or '' when the payload names no repo. */
  repo: string;
  /** Issue/PR number when the payload carries one. */
  number?: number;
  /** Provider-side login of the actor who caused the event ('' if absent). */
  sender: string;
  /** Provider delivery id (e.g. the `x-github-delivery` GUID) when the
   *  delivery carried one. Resolvers use it to dedupe webhook redeliveries. */
  deliveryId?: string;
  /** Absolute path of the persisted (bounded, redacted) raw payload, or ''
   *  when persistence was unavailable. Resolvers re-read details from here. */
  payloadRef: string;
  /** ISO timestamp of ingress receipt. */
  receivedAt: string;
}

/** Everything a provider needs to prove a delivery's authenticity. */
export interface TriggerVerifyInput {
  /** Raw request headers (node:http shape — values may be arrays). */
  headers: Record<string, string | string[] | undefined>;
  /** The EXACT bytes of the request body — HMACs are computed over bytes,
   *  not over a re-serialized parse. */
  rawBody: Buffer;
  /** The shared webhook secret. '' = unset → verification MUST fail. */
  secret: string;
}

/** The partial event a provider extracts; the server adds the envelope. */
export interface NormalizedTriggerEvent {
  kind: TriggerEventKind;
  repo: string;
  number?: number;
  sender: string;
  /** Provider delivery id, when the provider stamps one on the request. */
  deliveryId?: string;
}

/**
 * A provider adapter. Implementations must be pure/deterministic (no I/O) so
 * they are trivially testable and safe to call before any trust is
 * established.
 */
export interface TriggerProvider {
  /** Registry key + URL path segment (`POST /triggers/<name>/events`). */
  name: string;
  /** Lower-cased header that carries the delivery signature. The server
   *  rejects (401) before reading the body when this header is absent. */
  signatureHeader: string;
  /** Timing-safe signature check over the raw body bytes. MUST return false
   *  for an empty/unset secret (fail-closed). */
  verifySignature(input: TriggerVerifyInput): boolean;
  /** Reduce a parsed payload to the neutral shape, or null for deliveries
   *  that carry no actionable event (the server answers 202). */
  normalize(
    headers: Record<string, string | string[] | undefined>,
    payload: unknown,
  ): NormalizedTriggerEvent | null;
}

/** Injectable downstream consumer of verified + allowlisted events. */
export type TriggerSink = (event: TriggerEvent) => void | Promise<void>;

/** Pick the first value of a possibly-multi header, trimmed. */
export function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? '').trim();
  return (value ?? '').trim();
}
