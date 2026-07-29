/**
 * Presentation-head commands sent to an agent host.
 *
 * The command union and its structural guard stay dependency-free so the same
 * wire vocabulary is usable by CLI, Desktop, and utility-process hosts.
 */

import type { InteractionResponse } from './interaction.js';

/**
 * An image sent inline with a turn (pasted screenshot / attached picture), for
 * vision-capable models. `dataBase64` is the raw base64 payload WITHOUT the
 * `data:<mime>;base64,` prefix; `mediaType` is the MIME type (e.g. image/png).
 */
export interface AgentImage {
  mediaType: string;
  dataBase64: string;
}

export type ComputerUseActionName =
  | 'screenshot'
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'move'
  | 'type'
  | 'key'
  | 'scroll'
  | 'drag';

export interface ComputerUseAction {
  action: ComputerUseActionName;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  keys?: string | string[];
  clicks?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  button?: 'left' | 'right' | 'middle';
  hold_keys?: string[];
}

export interface ComputerUseActionResult {
  success: boolean;
  error?: string;
  permissionDenied?: boolean;
}

export interface ComputerUsePort {
  screenshot(): Promise<AgentImage>;
  act(action: ComputerUseAction): Promise<ComputerUseActionResult>;
}

export type AgentCommand =
  | {
      kind: 'start-turn';
      prompt: string;
      hidden?: boolean;
      images?: AgentImage[];
      delivery?: 'immediate' | 'queue' | 'steer';
      deliveryId?: string;
    }
  | { kind: 'interrupt' }
  | { kind: 'interaction-response'; id: string; response: InteractionResponse }
  | { kind: 'query'; id: string; name: string; args?: Record<string, unknown> }
  | { kind: 'new-session'; label?: string }
  | { kind: 'resume-session'; sessionKey: string }
  | { kind: 'set-model'; model: string; persist?: boolean; providerName?: string }
  | { kind: 'shutdown' };

const COMMAND_KINDS = new Set<string>([
  'start-turn',
  'interrupt',
  'interaction-response',
  'query',
  'new-session',
  'resume-session',
  'set-model',
  'shutdown',
]);

/** Structural guard for a wire-decoded command. Pure. */
export function isAgentCommand(value: unknown): value is AgentCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === 'string' && COMMAND_KINDS.has(v.kind);
}
