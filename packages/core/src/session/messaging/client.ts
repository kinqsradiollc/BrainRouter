/**
 * ADR-034 local discovery, liveness probing, stale reaping, and delivery.
 *
 * Registry data never becomes a general URL: every request is rebuilt against
 * 127.0.0.1 and the validated numeric port. A queued receipt means only that
 * the exact live session admitted the message to its bounded mailbox.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import {
  LOCAL_SESSION_AUTH_HEADER,
  LOCAL_SESSION_HOST,
  LOCAL_SESSION_MAX_BODY_BYTES,
  LOCAL_SESSION_MAX_TEXT_BYTES,
  LOCAL_SESSION_PROTOCOL,
  type LocalDeliveryFailureReason,
  type LocalDeliveryReceipt,
  type PeerSessionMessageInput,
  type LocalSessionMessageInput,
  type SessionRouteDescriptor,
} from './contracts.js';
import { getLocalMessagingDeviceId } from './identity.js';
import {
  listLocalSessionRegistryEntries,
  removeLocalSessionRegistryEntry,
  type LocalSessionRegistryEntry,
} from './registry.js';
import { requireMessageId, requireMessageText, requireSessionKey } from './validation.js';
import { createLocalSessionSenderProof } from './senderProof.js';

const HEALTH_PATH = '/session-messaging/v1/health';
const MESSAGES_PATH = '/session-messaging/v1/messages';
const DEFAULT_PROBE_TIMEOUT_MS = 350;
const DEFAULT_DELIVERY_TIMEOUT_MS = 2_000;
const MAX_PROBE_CONCURRENCY = 8;
const FAILURE_REASONS = new Set<LocalDeliveryFailureReason>([
  'not_found',
  'unreachable',
  'ambiguous',
  'queue_full',
  'expired',
  'payload_too_large',
  'invalid_message',
  'self_send',
  'id_conflict',
  'rejected',
]);

export interface LocalSessionDiscoveryOptions {
  probeTimeoutMs?: number;
  now?: () => number;
}

export interface LocalSessionSendOptions extends LocalSessionDiscoveryOptions {
  deliveryTimeoutMs?: number;
}

export async function discoverLocalSessionRoutes(
  options: LocalSessionDiscoveryOptions = {},
): Promise<SessionRouteDescriptor[]> {
  const deviceId = getLocalMessagingDeviceId();
  const candidates = listLocalSessionRegistryEntries().filter((entry) => entry.deviceId === deviceId);
  const live = await probeAndReapLocalSessionRegistryEntries(
    candidates,
    timeout(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
  );
  const lastSeenAt = (options.now ?? Date.now)();
  const grouped = new Map<string, LocalSessionRegistryEntry[]>();
  for (const entry of live) {
    const group = grouped.get(entry.sessionKey);
    if (group) group.push(entry);
    else grouped.set(entry.sessionKey, [entry]);
  }
  return [...grouped.values()]
    .map((entries) => routeForEntries(entries, lastSeenAt))
    .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
}

export async function sendLocalSessionMessage(
  targetSessionKey: string,
  input: LocalSessionMessageInput,
  options: LocalSessionSendOptions = {},
): Promise<LocalDeliveryReceipt> {
  let target: string;
  let sender: string;
  let text: string;
  let messageId: string;
  try {
    target = requireSessionKey(targetSessionKey);
    sender = requireSessionKey(input.senderSessionKey);
    if (typeof input.text === 'string' && Buffer.byteLength(input.text, 'utf8') > LOCAL_SESSION_MAX_TEXT_BYTES) {
      return failure(target, 'payload_too_large', input.id);
    }
    text = requireMessageText(input.text);
    messageId = input.id === undefined ? crypto.randomUUID() : requireMessageId(input.id);
  } catch {
    return failure(typeof targetSessionKey === 'string' ? targetSessionKey : '', 'invalid_message', input.id);
  }
  if (sender === target) return failure(target, 'self_send', messageId);

  const now = (options.now ?? Date.now)();
  const createdAt = input.createdAt ?? now;
  if (!Number.isInteger(createdAt) || createdAt < 0) {
    return failure(target, 'invalid_message', messageId);
  }
  const deviceId = getLocalMessagingDeviceId();
  const registrations = listLocalSessionRegistryEntries().filter((entry) => entry.deviceId === deviceId);
  const candidates = registrations.filter((entry) => entry.sessionKey === target);
  if (candidates.length === 0) return failure(target, 'not_found', messageId);

  const probeTimeoutMs = timeout(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  const [live, liveSenders] = await Promise.all([
    probeAndReapLocalSessionRegistryEntries(candidates, probeTimeoutMs),
    probeAndReapLocalSessionRegistryEntries(
      registrations.filter((entry) => entry.sessionKey === sender),
      probeTimeoutMs,
    ),
  ]);
  if (live.length === 0) return failure(target, 'unreachable', messageId);
  if (live.length > 1) return failure(target, 'ambiguous', messageId);
  if (liveSenders.length !== 1) return failure(target, 'rejected', messageId);

  const entry = live[0]!;
  const senderEntry = liveSenders[0]!;
  try {
    const envelope: PeerSessionMessageInput = {
      id: messageId,
      senderSessionKey: sender,
      senderDeviceId: deviceId,
      targetSessionKey: target,
      text,
      createdAt,
    };
    const deliveryTimeoutMs = timeout(options.deliveryTimeoutMs, DEFAULT_DELIVERY_TIMEOUT_MS);
    const response = await deliver(entry, envelope, senderEntry, deliveryTimeoutMs);
    if (response.status === 401) {
      return recoverUnauthorizedDelivery({
        recipient: entry,
        senderEntry,
        envelope,
        targetSessionKey: target,
        messageId,
        deviceId,
        probeTimeoutMs,
        deliveryTimeoutMs,
      });
    }
    const receipt = parseReceipt(response.body, target, messageId);
    if (receipt) return receipt;
    if (response.status === 404 || response.status >= 500) {
      reap(entry);
      return failure(target, 'unreachable', messageId);
    }
    return failure(target, statusReason(response.status), messageId);
  } catch {
    reap(entry);
    return failure(target, 'unreachable', messageId);
  }
}

export async function probeAndReapLocalSessionRegistryEntries(
  entries: readonly LocalSessionRegistryEntry[],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<LocalSessionRegistryEntry[]> {
  if (entries.length === 0) return [];
  const boundedTimeoutMs = timeout(timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  const live: LocalSessionRegistryEntry[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const entry = entries[index]!;
      if (await probeLocalSessionRegistryEntry(entry, boundedTimeoutMs)) live.push(entry);
      else reap(entry);
    }
  };
  const workerCount = Math.min(MAX_PROBE_CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return live;
}

export async function probeLocalSessionRegistryEntry(
  entry: LocalSessionRegistryEntry,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const boundedTimeoutMs = timeout(timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const response = await requestJson(entry, HEALTH_PATH, 'GET', undefined, boundedTimeoutMs);
    const body = asRecord(response.body);
    return response.status === 200 && body.protocol === LOCAL_SESSION_PROTOCOL &&
      body.sessionKey === entry.sessionKey && body.instanceId === entry.instanceId &&
      body.deviceId === entry.deviceId;
  } catch {
    return false;
  }
}

interface UnauthorizedDeliveryRecoveryInput {
  recipient: LocalSessionRegistryEntry;
  senderEntry: LocalSessionRegistryEntry;
  envelope: PeerSessionMessageInput;
  targetSessionKey: string;
  messageId: string;
  deviceId: string;
  probeTimeoutMs: number;
  deliveryTimeoutMs: number;
}

async function recoverUnauthorizedDelivery(
  input: UnauthorizedDeliveryRecoveryInput,
): Promise<LocalDeliveryReceipt> {
  // A 401 can mean the recipient capability is stale, but it can also mean
  // the sender rolled over after the client made its proof. Re-probe the exact
  // recipient before reaping so sender churn cannot erase a healthy target.
  if (!await probeLocalSessionRegistryEntry(input.recipient, input.probeTimeoutMs)) {
    reap(input.recipient);
    return failure(input.targetSessionKey, 'unreachable', input.messageId);
  }

  const currentSenders = listLocalSessionRegistryEntries().filter((entry) =>
    entry.deviceId === input.deviceId && entry.sessionKey === input.envelope.senderSessionKey);
  const liveSenders = await probeAndReapLocalSessionRegistryEntries(
    currentSenders,
    input.probeTimeoutMs,
  );
  if (liveSenders.length !== 1) {
    return failure(input.targetSessionKey, 'rejected', input.messageId);
  }
  const currentSender = liveSenders[0]!;
  if (currentSender.instanceId === input.senderEntry.instanceId &&
      currentSender.token === input.senderEntry.token) {
    return failure(input.targetSessionKey, 'rejected', input.messageId);
  }

  try {
    const retry = await deliver(input.recipient, input.envelope, currentSender, input.deliveryTimeoutMs);
    if (retry.status === 401) {
      if (!await probeLocalSessionRegistryEntry(input.recipient, input.probeTimeoutMs)) {
        reap(input.recipient);
        return failure(input.targetSessionKey, 'unreachable', input.messageId);
      }
      return failure(input.targetSessionKey, 'rejected', input.messageId);
    }
    const receipt = parseReceipt(retry.body, input.targetSessionKey, input.messageId);
    if (receipt) return receipt;
    if (retry.status === 404 || retry.status >= 500) {
      reap(input.recipient);
      return failure(input.targetSessionKey, 'unreachable', input.messageId);
    }
    return failure(input.targetSessionKey, statusReason(retry.status), input.messageId);
  } catch {
    if (!await probeLocalSessionRegistryEntry(input.recipient, input.probeTimeoutMs)) {
      reap(input.recipient);
    }
    return failure(input.targetSessionKey, 'unreachable', input.messageId);
  }
}

function deliver(
  recipient: LocalSessionRegistryEntry,
  envelope: PeerSessionMessageInput,
  sender: LocalSessionRegistryEntry,
  timeoutMs: number,
): Promise<JsonResponse> {
  return requestJson(recipient, MESSAGES_PATH, 'POST', {
    ...envelope,
    senderProof: createLocalSessionSenderProof(envelope, sender.instanceId, sender.token),
  }, timeoutMs);
}

interface JsonResponse {
  status: number;
  body: unknown;
}

function requestJson(
  entry: LocalSessionRegistryEntry,
  pathname: string,
  method: 'GET' | 'POST',
  body: object | undefined,
  timeoutMs: number,
): Promise<JsonResponse> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: LOCAL_SESSION_HOST,
      port: entry.port,
      path: pathname,
      method,
      headers: {
        [LOCAL_SESSION_AUTH_HEADER]: entry.token,
        ...(serialized === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized),
        }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (rawChunk: Buffer | string) => {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        total += chunk.length;
        if (total > LOCAL_SESSION_MAX_BODY_BYTES) {
          response.destroy(new Error('Local messaging response exceeds its bound.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) as unknown : {} });
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Local messaging request timed out.')));
    request.on('error', reject);
    if (serialized !== undefined) request.write(serialized);
    request.end();
  });
}

function routeForEntries(
  entries: readonly LocalSessionRegistryEntry[],
  lastSeenAt: number,
): SessionRouteDescriptor {
  const selected = [...entries].sort((left, right) => right.updatedAt - left.updatedAt)[0]!;
  return {
    sessionKey: selected.sessionKey,
    deviceId: selected.deviceId,
    clientKind: selected.clientKind,
    state: selected.state,
    transport: 'local',
    lastSeenAt,
    workspaceRoot: selected.workspaceRoot,
    title: selected.title,
    ...(entries.length > 1 ? { ambiguous: true } : {}),
    instanceCount: entries.length,
  };
}

function parseReceipt(
  value: unknown,
  targetSessionKey: string,
  messageId: string,
): LocalDeliveryReceipt | undefined {
  const record = asRecord(value);
  if (record.transport !== 'local' || record.targetSessionKey !== targetSessionKey ||
      record.status !== (record.queued === true ? 'queued' : 'not_queued')) {
    return undefined;
  }
  if (record.queued === true && record.messageId === messageId && typeof record.duplicate === 'boolean' &&
      Number.isFinite(record.acceptedAt) && (record.acceptedAt as number) >= 0 &&
      Number.isInteger(record.pending) && (record.pending as number) >= 0) {
    return {
      queued: true,
      status: 'queued',
      transport: 'local',
      messageId,
      targetSessionKey,
      acceptedAt: record.acceptedAt as number,
      pending: record.pending as number,
      duplicate: record.duplicate,
    };
  }
  if (record.queued === false && FAILURE_REASONS.has(record.reason as LocalDeliveryFailureReason)) {
    return failure(targetSessionKey, record.reason as LocalDeliveryFailureReason,
      typeof record.messageId === 'string' ? record.messageId : messageId);
  }
  return undefined;
}

function statusReason(status: number): LocalDeliveryFailureReason {
  if (status === 400) return 'invalid_message';
  if (status === 410) return 'expired';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'queue_full';
  return 'rejected';
}

function failure(
  targetSessionKey: string,
  reason: LocalDeliveryFailureReason,
  messageId?: string,
): LocalDeliveryReceipt {
  return {
    queued: false,
    status: 'not_queued',
    transport: 'local',
    targetSessionKey,
    reason,
    ...(messageId ? { messageId } : {}),
  };
}

function timeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 10 || resolved > 30_000) {
    throw new Error('Local messaging timeout must be between 10 and 30000 milliseconds.');
  }
  return resolved;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function reap(entry: LocalSessionRegistryEntry): void {
  try { removeLocalSessionRegistryEntry(entry); } catch { /* another process may already have reaped it */ }
}
