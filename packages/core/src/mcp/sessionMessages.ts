/**
 * ADR-034 remote session-message wake notification.
 *
 * The durable inbox remains authoritative. This notification carries only
 * recipient/message identifiers so a connected host can read and validate the
 * rows immediately instead of waiting for its fallback poll.
 */
import { NotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

export const SESSION_MESSAGE_NOTIFICATION_METHOD =
  'notifications/brainrouter/session-message' as const;

export const SessionMessageNotificationSchema = NotificationSchema.extend({
  method: z.literal(SESSION_MESSAGE_NOTIFICATION_METHOD),
  params: z.object({
    sessionKey: z.string().trim().min(1).max(512),
    messageIds: z.array(z.string().trim().min(1).max(512)).min(1).max(200),
  }),
});

export interface SessionMessageWake {
  sessionKey: string;
  messageIds: string[];
}

export type SessionMessageWakeListener = (
  wake: SessionMessageWake,
) => void | Promise<void>;
