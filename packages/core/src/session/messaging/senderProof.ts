/**
 * ADR-034 loopback sender proof: bind an exact same-installation sender and
 * immutable delivery envelope without treating authentication as authority.
 */
import crypto from 'node:crypto';
import type { PeerSessionMessageInput } from './contracts.js';

export interface LocalSessionSenderProof {
  instanceId: string;
  mac: string;
}

const INSTANCE_ID_PATTERN = /^[a-f0-9]{24}$/;
const MAC_PATTERN = /^[a-f0-9]{64}$/;

export function createLocalSessionSenderProof(
  message: PeerSessionMessageInput,
  instanceId: string,
  token: string,
): LocalSessionSenderProof {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error('Invalid local messaging sender instance id.');
  }
  return {
    instanceId,
    mac: crypto.createHmac('sha256', token).update(canonicalProofPayload(message, instanceId)).digest('hex'),
  };
}

export function verifyLocalSessionSenderProof(
  message: PeerSessionMessageInput,
  proof: unknown,
  expected: { instanceId: string; token: string },
): boolean {
  const record = proof && typeof proof === 'object' && !Array.isArray(proof)
    ? proof as Partial<LocalSessionSenderProof>
    : {};
  if (record.instanceId !== expected.instanceId ||
      typeof record.mac !== 'string' || !MAC_PATTERN.test(record.mac)) {
    return false;
  }
  const calculated = createLocalSessionSenderProof(message, expected.instanceId, expected.token).mac;
  return crypto.timingSafeEqual(Buffer.from(record.mac), Buffer.from(calculated));
}

function canonicalProofPayload(message: PeerSessionMessageInput, instanceId: string): string {
  return JSON.stringify([
    'session-messaging/sender-proof/v1',
    instanceId,
    message.id,
    message.senderSessionKey,
    message.senderDeviceId,
    message.targetSessionKey,
    message.text,
    message.createdAt,
  ]);
}
