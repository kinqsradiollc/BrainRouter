/**
 * ADR-034 authenticated loopback listener for one live session.
 *
 * It is separate from discovery/client code so recipient ingress has one owner
 * for authentication, mailbox admission, and shutdown. The listener binds only
 * 127.0.0.1 on an ephemeral port, verifies a private registry token before
 * reading a body, and acknowledges only bounded admission for an exact key.
 * Once close begins no request may newly cross admission; close awaits every
 * earlier handler so the host's final drain includes every emitted 202.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import {
  LOCAL_SESSION_AUTH_HEADER,
  LOCAL_SESSION_DEFAULT_MAX_AGE_MS,
  LOCAL_SESSION_DEFAULT_QUEUE_DEPTH,
  LOCAL_SESSION_HOST,
  LOCAL_SESSION_MAX_BODY_BYTES,
  LOCAL_SESSION_PROTOCOL,
  type LocalDeliveryFailureReason,
  type LocalDeliveryReceipt,
  type LocalMailboxDrain,
  type LocalNotQueuedReceipt,
  type LocalQueuedReceipt,
  type LocalSessionActivityState,
  type LocalSessionClientKind,
  type LocalSessionMessage,
  type LocalSessionRegistrationPatch,
  type PeerSessionMessageInput,
  type SessionRouteDescriptor,
} from './contracts.js';
import { getLocalMessagingDeviceId } from './identity.js';
import { LocalSessionMailbox } from './mailbox.js';
import {
  listLocalSessionRegistryEntries,
  newLocalSessionRegistryEntry,
  removeLocalSessionRegistryEntry,
  writeLocalSessionRegistryEntry,
  type LocalSessionRegistryEntry,
} from './registry.js';
import {
  optionalBoundedText,
  optionalBoundedTitle,
  requireDeviceId,
  requireMessageId,
  requireMessageText,
  requireSessionKey,
} from './validation.js';
import { verifyLocalSessionSenderProof } from './senderProof.js';
import { probeAndReapLocalSessionRegistryEntries } from './client.js';

const HEALTH_PATH = '/session-messaging/v1/health';
const MESSAGES_PATH = '/session-messaging/v1/messages';
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const LOCAL_SESSION_REQUEST_TIMEOUT_MS = 5_000;
const MAX_SENDER_REGISTRY_CANDIDATES = 32;

export interface StartLocalSessionTransportOptions {
  sessionKey: string;
  clientKind: LocalSessionClientKind;
  state?: LocalSessionActivityState;
  workspaceRoot?: string;
  title?: string;
  /** Defaults to 0 so every session receives an OS-selected ephemeral port. */
  port?: number;
  maxQueueDepth?: number;
  maxMessageAgeMs?: number;
  now?: () => number;
  /** Notification only; the host drains and applies its recipient-side gate. */
  onMessageAvailable?: (message: LocalSessionMessage) => void;
}

export interface LocalSessionTransportHandle {
  host: typeof LOCAL_SESSION_HOST;
  port: number;
  registration(): SessionRouteDescriptor;
  pendingCount(): number;
  drain(): LocalMailboxDrain;
  /** Feed remote push/poll envelopes through the same recipient dedupe gate. */
  acceptPeerMessage(message: PeerSessionMessageInput): LocalDeliveryReceipt;
  updateRegistration(patch: LocalSessionRegistrationPatch): SessionRouteDescriptor;
  close(): Promise<void>;
}

export async function startLocalSessionTransport(
  options: StartLocalSessionTransportOptions,
): Promise<LocalSessionTransportHandle> {
  const now = options.now ?? Date.now;
  const sessionKey = requireSessionKey(options.sessionKey);
  const workspaceRoot = optionalBoundedText(options.workspaceRoot, 4096);
  const title = optionalBoundedTitle(options.title);
  const registeredAt = now();
  const mailbox = new LocalSessionMailbox(
    options.maxQueueDepth ?? LOCAL_SESSION_DEFAULT_QUEUE_DEPTH,
    options.maxMessageAgeMs ?? LOCAL_SESSION_DEFAULT_MAX_AGE_MS,
  );
  const context: RequestHandlerContext = {
    options,
    sessionKey,
    mailbox,
    now,
    accepting: true,
    inFlight: new Set(),
  };
  const server = http.createServer(createRequestHandler(context));
  server.requestTimeout = LOCAL_SESSION_REQUEST_TIMEOUT_MS;
  server.headersTimeout = LOCAL_SESSION_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.setTimeout(LOCAL_SESSION_REQUEST_TIMEOUT_MS, (socket) => socket.destroy());
  const port = validatePort(options.port ?? 0);
  const boundPort = await listen(server, port);
  let entry = newLocalSessionRegistryEntry({
    sessionKey,
    deviceId: getLocalMessagingDeviceId(),
    clientKind: options.clientKind,
    state: options.state ?? 'idle',
    pid: process.pid,
    port: boundPort,
    registeredAt,
    updatedAt: registeredAt,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(title === undefined ? {} : { title }),
  });
  context.identity = entry;
  try {
    writeLocalSessionRegistryEntry(entry);
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  let closed = false;
  let closePromise: Promise<void> | null = null;
  return {
    host: LOCAL_SESSION_HOST,
    port: boundPort,
    registration: () => descriptor(entry, now()),
    pendingCount: () => mailbox.pending(now()),
    drain: () => mailbox.drain(now()),
    acceptPeerMessage: (input) => {
      if (closed) return failure(sessionKey, 'rejected', input.id);
      const receivedAt = now();
      try {
        return acceptMessage(context, parseMessage(input, receivedAt, true), receivedAt);
      } catch {
        return failure(sessionKey, 'invalid_message', input.id);
      }
    },
    updateRegistration: (patch) => {
      if (closed) throw new Error('Local session transport is closed.');
      entry = updateEntry(entry, patch, now());
      writeLocalSessionRegistryEntry(entry);
      context.identity = entry;
      return descriptor(entry, now());
    },
    close: async () => {
      if (closePromise) return closePromise;
      closed = true;
      context.accepting = false;
      closePromise = (async () => {
        await closeServer(server);
        await Promise.allSettled([...context.inFlight]);
        removeLocalSessionRegistryEntry(entry);
      })();
      return closePromise;
    },
  };
}

interface RequestHandlerContext {
  options: StartLocalSessionTransportOptions;
  sessionKey: string;
  mailbox: LocalSessionMailbox;
  now: () => number;
  /** Flips synchronously before listener shutdown. No request may cross the
   * mailbox admission seam once quiescence begins. */
  accepting: boolean;
  inFlight: Set<Promise<void>>;
  identity?: LocalSessionRegistryEntry;
}

function createRequestHandler(context: RequestHandlerContext): http.RequestListener {
  return (request, response) => {
    let task!: Promise<void>;
    task = handleRequest(request, response, context)
      .catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
      })
      .finally(() => { context.inFlight.delete(task); });
    context.inFlight.add(task);
  };
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestHandlerContext,
): Promise<void> {
  if (!context.accepting) return sendJson(response, 503, { error: 'shutting_down' });
  const identity = context.identity;
  if (!identity) return sendJson(response, 503, { error: 'not_registered' });
  const pathname = (request.url ?? '').split('?')[0];
  if (pathname !== HEALTH_PATH && pathname !== MESSAGES_PATH) {
    return sendJson(response, 404, { error: 'not_found' });
  }
  if (!isAuthorized(request, identity.token)) {
    return sendJson(response, 401, { error: 'unauthorized' });
  }
  if (pathname === HEALTH_PATH) {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'method_not_allowed' });
    return sendJson(response, 200, healthPayload(identity, context.now()));
  }
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });

  const body = await readJsonBody(request, LOCAL_SESSION_MAX_BODY_BYTES);
  if (body === null) {
    sendJson(response, 413, failure(identity.sessionKey, 'payload_too_large'));
    response.once('finish', () => request.destroy());
    return;
  }
  const receivedAt = context.now();
  let message: LocalSessionMessage;
  try {
    message = parseMessage(body, receivedAt);
  } catch {
    return sendJson(response, 400, failure(identity.sessionKey, 'invalid_message'));
  }
  if (message.targetSessionKey === identity.sessionKey && message.senderSessionKey !== identity.sessionKey &&
      !await hasAuthenticatedLiveSender(body, message, identity)) {
    return sendJson(response, 401, failure(identity.sessionKey, 'invalid_message', message.id));
  }
  // `close()` may have started while this request was reading or proving its
  // sender. Refuse before mailbox admission so a caller never observes 202 for
  // content that the host's final drain cannot see.
  if (!context.accepting) {
    return sendJson(response, 503, failure(identity.sessionKey, 'rejected', message.id));
  }
  const receipt = acceptMessage(context, message, receivedAt);
  sendJson(response, receipt.queued ? 202 : failureStatus(receipt.reason), receipt);
}

async function hasAuthenticatedLiveSender(
  body: unknown,
  message: LocalSessionMessage,
  recipient: LocalSessionRegistryEntry,
): Promise<boolean> {
  if (message.senderDeviceId !== recipient.deviceId) return false;
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const proof = record.senderProof;
  const senders = listLocalSessionRegistryEntries().filter((entry) =>
    entry.deviceId === recipient.deviceId &&
    entry.sessionKey === message.senderSessionKey);
  if (senders.length === 0 || senders.length > MAX_SENDER_REGISTRY_CANDIDATES) return false;
  const proven = senders.find((entry) => verifyLocalSessionSenderProof(message, proof, entry));
  if (!proven) return false;
  const live = await probeAndReapLocalSessionRegistryEntries(senders);
  return live.length === 1 && live[0]!.instanceId === proven.instanceId;
}

function parseMessage(
  value: unknown,
  receivedAt: number,
  preserveAuthoritativeExpiry = false,
): LocalSessionMessage {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const createdAt = record.createdAt;
  if (!Number.isInteger(createdAt) || (createdAt as number) < 0 ||
      (createdAt as number) > receivedAt + MAX_FUTURE_SKEW_MS) {
    throw new Error('Invalid local messaging timestamp or sender device.');
  }
  const expiresAt = preserveAuthoritativeExpiry ? record.expiresAt : undefined;
  if (expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < (createdAt as number) ||
       (expiresAt as number) > (createdAt as number) + LOCAL_SESSION_DEFAULT_MAX_AGE_MS)) {
    throw new Error('Invalid authoritative session message expiry.');
  }
  return {
    id: requireMessageId(record.id),
    senderSessionKey: requireSessionKey(record.senderSessionKey),
    senderDeviceId: requireDeviceId(record.senderDeviceId),
    targetSessionKey: requireSessionKey(record.targetSessionKey),
    text: requireMessageText(record.text),
    source: 'peer-session',
    trust: 'untrusted-session',
    createdAt: createdAt as number,
    receivedAt,
    ...(expiresAt !== undefined ? { expiresAt: expiresAt as number } : {}),
  };
}

function acceptMessage(
  context: RequestHandlerContext,
  message: LocalSessionMessage,
  receivedAt: number,
): LocalDeliveryReceipt {
  if (message.targetSessionKey !== context.sessionKey) {
    return failure(context.sessionKey, 'rejected', message.id);
  }
  if (message.senderSessionKey === context.sessionKey) {
    return failure(context.sessionKey, 'self_send', message.id);
  }
  const accepted = context.mailbox.enqueue(message, receivedAt);
  if (!accepted.accepted) {
    return failure(context.sessionKey, accepted.reason, message.id);
  }
  if (!accepted.duplicate) {
    try { context.options.onMessageAvailable?.({ ...message }); } catch { /* notification cannot revoke admission */ }
  }
  const receipt: LocalQueuedReceipt = {
    queued: true,
    status: 'queued',
    transport: 'local',
    messageId: message.id,
    targetSessionKey: context.sessionKey,
    acceptedAt: accepted.acceptedAt,
    pending: accepted.pending,
    duplicate: accepted.duplicate,
  };
  return receipt;
}

function updateEntry(
  entry: LocalSessionRegistryEntry,
  patch: LocalSessionRegistrationPatch,
  updatedAt: number,
): LocalSessionRegistryEntry {
  const state = patch.state ?? entry.state;
  if (!new Set<LocalSessionActivityState>(['idle', 'working', 'waiting']).has(state)) {
    throw new Error('Invalid local messaging activity state.');
  }
  const workspaceRoot = patch.workspaceRoot === undefined
    ? entry.workspaceRoot : optionalBoundedText(patch.workspaceRoot, 4096);
  const title = patch.title === undefined ? entry.title : optionalBoundedTitle(patch.title);
  return {
    ...entry,
    state,
    updatedAt: Math.max(entry.updatedAt, updatedAt),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(title === undefined ? {} : { title }),
  };
}

function descriptor(entry: LocalSessionRegistryEntry, lastSeenAt: number): SessionRouteDescriptor {
  return {
    sessionKey: entry.sessionKey,
    deviceId: entry.deviceId,
    clientKind: entry.clientKind,
    state: entry.state,
    transport: 'local',
    lastSeenAt,
    workspaceRoot: entry.workspaceRoot,
    title: entry.title,
    instanceCount: 1,
  };
}

function healthPayload(entry: LocalSessionRegistryEntry, lastSeenAt: number): Record<string, unknown> {
  return {
    protocol: LOCAL_SESSION_PROTOCOL,
    sessionKey: entry.sessionKey,
    instanceId: entry.instanceId,
    deviceId: entry.deviceId,
    lastSeenAt,
  };
}

function failure(
  targetSessionKey: string,
  reason: LocalDeliveryFailureReason,
  messageId?: string,
): LocalNotQueuedReceipt {
  return {
    queued: false,
    status: 'not_queued',
    transport: 'local',
    targetSessionKey,
    reason,
    ...(messageId ? { messageId } : {}),
  };
}

function failureStatus(reason: LocalDeliveryFailureReason): number {
  if (reason === 'invalid_message') return 400;
  if (reason === 'expired') return 410;
  if (reason === 'payload_too_large') return 413;
  if (reason === 'queue_full') return 429;
  return 409;
}

function isAuthorized(request: http.IncomingMessage, expected: string): boolean {
  const raw = request.headers[LOCAL_SESSION_AUTH_HEADER];
  const presented = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  if (presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

async function readJsonBody(request: http.IncomingMessage, cap: number): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > cap) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return {};
  }
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Local session messaging port must be between 0 and 65535.');
  }
  return port;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOCAL_SESSION_HOST, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Local session listener has no TCP address.'));
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function sendJson(response: http.ServerResponse, status: number, body: object): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(serialized),
  });
  response.end(serialized);
}
