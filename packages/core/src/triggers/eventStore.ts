/**
 * MC-B1 — bounded, redacted persistence of raw trigger payloads. Resolvers
 * (MC-B2+) re-read provider details from the `payloadRef` file instead of the
 * neutral event carrying the whole body. Two hard properties:
 *
 * - BOUNDED: payloads are truncated to `TRIGGER_PAYLOAD_MAX_BYTES` before the
 *   write — a hostile sender cannot fill the disk through the ingress.
 * - REDACTED: the existing secret redactor runs over the text first, so a
 *   payload that happens to embed a token shape never lands on disk verbatim.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../git/prEmit.js';
import { getWorkspaceStateRoot } from '../storage/store.js';

/** Cap on the persisted payload text (bytes of UTF-8 input, pre-redaction). */
export const TRIGGER_PAYLOAD_MAX_BYTES = 256 * 1024;

/** Directory the ingress writes raw payloads into (workspace state root). */
export function triggerEventsDir(workspaceRoot: string): string {
  return path.join(getWorkspaceStateRoot(workspaceRoot), 'triggers', 'events');
}

/**
 * Persist one raw payload; returns the absolute file path (the event's
 * `payloadRef`), or '' when persistence failed — ingress never dies on a
 * disk error, the event simply carries no payload reference.
 */
export function persistTriggerPayload(
  workspaceRoot: string,
  provider: string,
  rawBody: Buffer,
): string {
  try {
    const dir = triggerEventsDir(workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    const bounded = rawBody.subarray(0, TRIGGER_PAYLOAD_MAX_BYTES).toString('utf8');
    const redacted = redactSecrets(bounded);
    const safeProvider = provider.replace(/[^a-z0-9_-]/gi, '') || 'unknown';
    const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeProvider}.json`);
    fs.writeFileSync(file, redacted, 'utf8');
    return file;
  } catch {
    return '';
  }
}
