/**
 * Cross-host delegation normalization.
 *
 * Transport metadata may wrap the same bounded task packet used for local
 * children, but it cannot widen that packet's capabilities, tools, access, or
 * budgets. Legacy persisted rows remain readable and normalize to a read-only,
 * tool-free packet; all new writes use the canonical envelope.
 */

import type {
  DelegationPacket,
  StoredDelegationPacket,
} from '@kinqs/brainrouter-types/agent';
import {
  isDelegatedTaskPacket,
  legacyDelegatedTaskPacket,
  legacyDelegationPayload,
  normalizeDelegatedTaskPacket,
} from './taskPacketNormalization.js';

export function buildCrossHostDelegationPacket(
  fromSessionKey: string,
  payload: Record<string, unknown>,
  createdAt: string,
): DelegationPacket {
  const candidate = record(payload.taskPacket) ?? payload;
  const taskPacket = isDelegatedTaskPacket(candidate)
    ? normalizeDelegatedTaskPacket(candidate)
    : legacyDelegatedTaskPacket(payload);
  const suppliedOrigin = record(payload.origin);

  return {
    ...taskPacket,
    origin: {
      fromSessionKey: boundedRequired(fromSessionKey, 500, 'sender session key'),
      originatingClient: bounded(
        text(payload.originatingClient)
          || text(suppliedOrigin?.originatingClient)
          || 'unknown',
        120,
      ),
      originatingWorkspace: bounded(
        text(payload.originatingWorkspace)
          || text(suppliedOrigin?.originatingWorkspace),
        1_000,
      ),
      createdAt: boundedRequired(createdAt, 120, 'delegation creation time'),
    },
  };
}

/** Normalize canonical and legacy stored rows into the one current envelope. */
export function normalizeStoredDelegationPacket(
  packet: StoredDelegationPacket,
): DelegationPacket {
  if (isDelegationPacket(packet)) {
    return buildCrossHostDelegationPacket(
      packet.origin.fromSessionKey,
      {
        taskPacket: packet,
        originatingClient: packet.origin.originatingClient,
        originatingWorkspace: packet.origin.originatingWorkspace,
      },
      packet.origin.createdAt,
    );
  }
  return buildCrossHostDelegationPacket(
    packet.fromSessionKey,
    legacyDelegationPayload(packet),
    packet.createdAt,
  );
}

export function isDelegationPacket(
  value: unknown,
): value is DelegationPacket {
  return isDelegatedTaskPacket(value) && record(record(value)?.origin) !== undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedRequired(value: string, max: number, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return bounded(normalized, max);
}

function bounded(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(0, max - 1))}…`;
}
