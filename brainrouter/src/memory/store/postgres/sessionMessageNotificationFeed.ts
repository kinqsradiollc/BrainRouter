/**
 * ADR-034 reconnecting Postgres LISTEN feed for committed message-id hints;
 * durable inbox rows remain authoritative through every disconnect.
 */
import type { Pool, PoolClient } from "pg";
import {
  SESSION_MESSAGE_NOTIFICATION_CHANNEL,
  SESSION_MESSAGE_STATUSES,
  type SessionMessageStatus,
  type SessionMessageStoreNotification,
} from "@kinqs/brainrouter-types";

export interface SessionMessageNotificationFeed {
  /** Resolves after the first LISTEN succeeds; delivery retries in the background. */
  ready: Promise<void>;
  close(): Promise<void>;
}

const STATUS_SET = new Set<string>(SESSION_MESSAGE_STATUSES);

/**
 * Dedicated, reconnecting Postgres LISTEN connection.
 *
 * A database notification is only a wake hint. Invalid or lost hints are safe
 * because every recipient still polls the durable inbox after reconnect.
 */
export function startSessionMessageNotificationFeed(
  pool: Pool,
  listener: (notification: SessionMessageStoreNotification) => void | Promise<void>,
  options: { retryMinMs?: number; retryMaxMs?: number } = {},
): SessionMessageNotificationFeed {
  const retryMinMs = boundedDelay(options.retryMinMs ?? 250);
  const retryMaxMs = boundedDelay(options.retryMaxMs ?? 5_000);
  if (retryMinMs > retryMaxMs) throw new Error("Notification retry minimum exceeds maximum.");

  let stopped = false;
  let releaseLoss: (() => void) | undefined;
  let resolveReady!: () => void;
  let readyResolved = false;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  const run = (async () => {
    let attempt = 0;
    while (!stopped) {
      let client: PoolClient | undefined;
      try {
        client = await pool.connect();
        if (stopped) { client.release(); break; }
        await client.query(`LISTEN ${SESSION_MESSAGE_NOTIFICATION_CHANNEL}`);
        attempt = 0;
        if (!readyResolved) { readyResolved = true; resolveReady(); }

        await new Promise<void>((resolve) => {
          releaseLoss = resolve;
          const onNotification = (message: { channel: string; payload?: string }): void => {
            if (message.channel !== SESSION_MESSAGE_NOTIFICATION_CHANNEL || !message.payload) return;
            const notification = parseNotification(message.payload);
            if (!notification) return;
            void Promise.resolve(listener(notification)).catch(() => {
              // Listener failure cannot poison the database receive loop.
            });
          };
          const onLost = (): void => resolve();
          client!.on("notification", onNotification);
          client!.once("error", onLost);
          client!.once("end", onLost);
          if (stopped) resolve();
        });
      } catch (error) {
        if (!stopped) {
          console.error("[BrainRouter] session-message notification feed disconnected:",
            error instanceof Error ? error.message : String(error));
        }
      } finally {
        releaseLoss = undefined;
        if (client) {
          try { await client.query(`UNLISTEN ${SESSION_MESSAGE_NOTIFICATION_CHANNEL}`); } catch { /* connection already lost */ }
          client.removeAllListeners("notification");
          client.release(true);
        }
      }
      if (!stopped) {
        const delay = Math.min(retryMaxMs, retryMinMs * (2 ** Math.min(attempt++, 6)));
        await wait(delay);
      }
    }
  })();

  return {
    ready,
    async close() {
      if (stopped) return;
      stopped = true;
      if (!readyResolved) { readyResolved = true; resolveReady(); }
      releaseLoss?.();
      await run;
    },
  };
}

function parseNotification(payload: string): SessionMessageStoreNotification | null {
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !(value.orgId === null || typeof value.orgId === "string") ||
    typeof value.userId !== "string" || !value.userId ||
    typeof value.fromSessionKey !== "string" || !value.fromSessionKey ||
    typeof value.toSessionKey !== "string" || !value.toSessionKey ||
    typeof value.messageId !== "string" || !value.messageId ||
    typeof value.inboxId !== "string" || !value.inboxId ||
    typeof value.status !== "string" || !STATUS_SET.has(value.status)
  ) return null;
  return {
    version: 1,
    orgId: value.orgId as string | null,
    userId: value.userId,
    fromSessionKey: value.fromSessionKey,
    toSessionKey: value.toSessionKey,
    messageId: value.messageId,
    inboxId: value.inboxId,
    status: value.status as SessionMessageStatus,
  };
}

function boundedDelay(value: number): number {
  if (!Number.isInteger(value) || value < 10 || value > 60_000) {
    throw new Error("Notification retry delay must be between 10 and 60000 milliseconds.");
  }
  return value;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
