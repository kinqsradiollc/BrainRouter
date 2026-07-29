import type {
  TerminalReadView,
  TerminalSessionView,
  TerminalShellCatalogView,
  TerminalShellView,
} from './contracts.js';

const MAX_TEXT_LENGTH = 1_000_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maxLength = 1_024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum;
}

function shellView(value: unknown): TerminalShellView | null {
  const candidate = record(value);
  if (
    !candidate
    || !text(candidate.id, 128)
    || !text(candidate.label, 256)
    || !text(candidate.description, 1_024)
    || typeof candidate.isDefault !== 'boolean'
  ) return null;
  return {
    id: candidate.id,
    label: candidate.label,
    description: candidate.description,
    isDefault: candidate.isDefault,
  };
}

/** Validate and copy an untrusted terminal shell catalog. */
export function projectTerminalShellCatalog(value: unknown): TerminalShellCatalogView | null {
  const candidate = record(value);
  if (!candidate || !text(candidate.selected, 128) || !Array.isArray(candidate.shells)) return null;
  const shells = candidate.shells.map(shellView);
  if (
    shells.length === 0
    || shells.length > 32
    || shells.some((shell) => shell === null)
    || !shells.some((shell) => shell?.id === candidate.selected)
  ) return null;
  return {
    selected: candidate.selected,
    shells: shells as TerminalShellView[],
  };
}

/** Validate and copy an untrusted terminal-open result. */
export function projectTerminalSession(value: unknown): TerminalSessionView | null {
  const candidate = record(value);
  if (
    !candidate
    || !text(candidate.id, 128)
    || typeof candidate.reused !== 'boolean'
    || typeof candidate.snapshot !== 'string'
    || candidate.snapshot.length > MAX_TEXT_LENGTH
    || !integer(candidate.start)
    || !integer(candidate.next)
    || candidate.next < candidate.start
    || typeof candidate.alive !== 'boolean'
    || !text(candidate.shellId, 128)
    || !text(candidate.label, 256)
  ) return null;
  return {
    id: candidate.id,
    reused: candidate.reused,
    snapshot: candidate.snapshot,
    start: candidate.start,
    next: candidate.next,
    alive: candidate.alive,
    shellId: candidate.shellId,
    label: candidate.label,
  };
}

/** Validate and copy an untrusted incremental terminal read. */
export function projectTerminalRead(value: unknown): TerminalReadView | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.chunk !== 'string'
    || candidate.chunk.length > MAX_TEXT_LENGTH
    || !integer(candidate.next)
    || typeof candidate.alive !== 'boolean'
    || !integer(candidate.dropped)
  ) return null;
  return {
    chunk: candidate.chunk,
    next: candidate.next,
    alive: candidate.alive,
    dropped: candidate.dropped,
  };
}
