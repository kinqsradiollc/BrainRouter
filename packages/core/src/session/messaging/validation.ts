/**
 * ADR-034 validation shared by the local registry and listener.
 *
 * Session keys are canonical identities, so surrounding whitespace and control
 * characters are rejected instead of normalized into a possibly different
 * recipient. Human-readable titles never pass through this identity helper.
 */

import { MAX_SESSION_TITLE } from '../sessionTitle.js';
import { LOCAL_SESSION_MAX_TEXT_BYTES } from './contracts.js';

export { sanitizePeerTextForTerminal } from '@kinqs/brainrouter-types/peer-presentation';

const SESSION_KEY_MAX_BYTES = 512;
const MESSAGE_ID_MAX_BYTES = 160;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function requireSessionKey(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
      CONTROL_CHARACTER.test(value) || Buffer.byteLength(value, 'utf8') > SESSION_KEY_MAX_BYTES) {
    throw new Error('Invalid local messaging session key.');
  }
  return value;
}

export function requireMessageId(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
      CONTROL_CHARACTER.test(value) || Buffer.byteLength(value, 'utf8') > MESSAGE_ID_MAX_BYTES) {
    throw new Error('Invalid local messaging message id.');
  }
  return value;
}

export function requireDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new Error('Invalid local messaging device id.');
  }
  return value;
}

export function requireMessageText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() ||
      Buffer.byteLength(value, 'utf8') > LOCAL_SESSION_MAX_TEXT_BYTES) {
    throw new Error('Invalid local messaging message text.');
  }
  return value;
}

export function optionalBoundedText(value: unknown, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value) ||
      Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error('Invalid local messaging registry text.');
  }
  return value;
}

/**
 * Session titles use the product's JavaScript string-length contract. This is
 * deliberately separate from workspaceRoot, whose registry boundary remains
 * a UTF-8 byte bound.
 */
export function optionalBoundedTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value) || value.length > MAX_SESSION_TITLE) {
    throw new Error('Invalid local messaging session title.');
  }
  return value;
}
