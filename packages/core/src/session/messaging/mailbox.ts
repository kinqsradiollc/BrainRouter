/**
 * ADR-034 bounded in-process inbox for one live session.
 *
 * New messages are rejected when full instead of silently displacing unread
 * work. Expiry notices are retained separately and bounded so a host can state
 * that accepted messages aged out without turning the notice path into a new
 * unbounded queue.
 */

import type {
  LocalMailboxDrain,
  LocalMessageExpiryNotice,
  LocalSessionMessage,
} from './contracts.js';
import {
  LOCAL_SESSION_DEFAULT_MAX_AGE_MS,
  LOCAL_SESSION_DEFAULT_QUEUE_DEPTH,
  LOCAL_SESSION_MAX_ACCEPTED_IDS,
} from './contracts.js';

export type LocalMailboxEnqueueResult =
  | { accepted: true; acceptedAt: number; pending: number; duplicate: boolean }
  | { accepted: false; reason: 'queue_full' | 'expired' | 'id_conflict' };

interface AcceptedMessageId {
  acceptedAt: number;
  expiresAt: number;
  signature: string;
}

export class LocalSessionMailbox {
  private messages: LocalSessionMessage[] = [];
  private expiryNotices: LocalMessageExpiryNotice[] = [];
  private omittedExpiryNotices = 0;
  private readonly acceptedIds = new Map<string, AcceptedMessageId>();

  constructor(
    private readonly maxDepth: number,
    private readonly maxAgeMs: number,
    private readonly maxAcceptedIds = LOCAL_SESSION_MAX_ACCEPTED_IDS,
  ) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > LOCAL_SESSION_DEFAULT_QUEUE_DEPTH) {
      throw new Error(`Local session mailbox depth must be between 1 and ${LOCAL_SESSION_DEFAULT_QUEUE_DEPTH}.`);
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > LOCAL_SESSION_DEFAULT_MAX_AGE_MS) {
      throw new Error(`Local session mailbox age must be between 1 and ${LOCAL_SESSION_DEFAULT_MAX_AGE_MS}.`);
    }
    if (!Number.isInteger(maxAcceptedIds) || maxAcceptedIds < maxDepth ||
        maxAcceptedIds > LOCAL_SESSION_MAX_ACCEPTED_IDS) {
      throw new Error(`Local session accepted-id capacity must be between ${maxDepth} and ${LOCAL_SESSION_MAX_ACCEPTED_IDS}.`);
    }
  }

  enqueue(message: LocalSessionMessage, now: number): LocalMailboxEnqueueResult {
    this.prune(now);
    const expiresAt = messageExpiry(message, this.maxAgeMs);
    const signature = messageSignature(message);
    const prior = this.acceptedIds.get(message.id);
    if (prior) {
      if (prior.signature !== signature) return { accepted: false, reason: 'id_conflict' };
      return {
        accepted: true,
        acceptedAt: prior.acceptedAt,
        pending: this.messages.length,
        duplicate: true,
      };
    }
    if (now - message.createdAt >= this.maxAgeMs || expiresAt <= now) {
      return { accepted: false, reason: 'expired' };
    }
    if (this.messages.length >= this.maxDepth || this.acceptedIds.size >= this.maxAcceptedIds) {
      return { accepted: false, reason: 'queue_full' };
    }
    this.messages.push({ ...message });
    this.acceptedIds.set(message.id, { acceptedAt: now, expiresAt, signature });
    return {
      accepted: true,
      acceptedAt: now,
      pending: this.messages.length,
      duplicate: false,
    };
  }

  pending(now: number): number {
    this.prune(now);
    return this.messages.length;
  }

  drain(now: number): LocalMailboxDrain {
    this.prune(now);
    const result: LocalMailboxDrain = {
      messages: this.messages.map((message) => ({ ...message })),
      expired: this.expiryNotices.map((notice) => ({ ...notice })),
      expiredOmitted: this.omittedExpiryNotices,
    };
    this.messages = [];
    this.expiryNotices = [];
    this.omittedExpiryNotices = 0;
    return result;
  }

  private prune(now: number): void {
    const retained: LocalSessionMessage[] = [];
    for (const message of this.messages) {
      if (messageExpiry(message, this.maxAgeMs) > now) {
        retained.push(message);
        continue;
      }
      this.recordExpiry(message, now);
    }
    this.messages = retained;
    for (const [messageId, accepted] of this.acceptedIds) {
      if (accepted.expiresAt <= now) this.acceptedIds.delete(messageId);
    }
  }

  private recordExpiry(message: LocalSessionMessage, expiredAt: number): void {
    this.expiryNotices.push({
      messageId: message.id,
      senderSessionKey: message.senderSessionKey,
      expiredAt,
    });
    if (this.expiryNotices.length > this.maxDepth) {
      const omitted = this.expiryNotices.length - this.maxDepth;
      this.expiryNotices.splice(0, omitted);
      this.omittedExpiryNotices += omitted;
    }
  }
}

function messageSignature(message: LocalSessionMessage): string {
  return JSON.stringify([
    message.senderSessionKey,
    message.targetSessionKey,
    message.text,
    message.expiresAt ?? null,
  ]);
}

function messageExpiry(message: LocalSessionMessage, maxAgeMs: number): number {
  const localDeadline = message.receivedAt + maxAgeMs;
  return message.expiresAt === undefined
    ? localDeadline
    : Math.min(message.expiresAt, localDeadline);
}
