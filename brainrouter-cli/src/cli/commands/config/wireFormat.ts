// Per-provider wire-format overrides (`cli.providerRequestFormat`). Kept PURE
// (config-in, config-mutated) so the rows/apply helpers unit-test without a
// CommandContext or an interactive picker.
import type { CommandContext } from '../_context.js';
import { PROVIDER_CATALOG } from '@kinqs/brainrouter-core/provider';

export const WIRE_FORMAT_OPTIONS = ['default', 'chat-completions', 'responses', 'anthropic-messages', 'gemini-generate'] as const;
export type WireFormatOption = (typeof WIRE_FORMAT_OPTIONS)[number];
export type WireFormatOverride = Exclude<WireFormatOption, 'default'>;

export interface ProviderRequestFormatRow {
  id: string;
  label: string;
  description: string;
  savedNames: string[];
}

function normalizeWireProviderId(id: string | undefined): string {
  return (id ?? '').trim().toLowerCase();
}

export function listProviderRequestFormatRows(config: CommandContext['config']): ProviderRequestFormatRow[] {
  const savedByProvider = new Map<string, string[]>();
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const id = normalizeWireProviderId(provider.provider || name);
    if (!id) continue;
    const names = savedByProvider.get(id) ?? [];
    names.push(name);
    savedByProvider.set(id, names);
  }

  const catalogById = new Map(PROVIDER_CATALOG.map((p) => [normalizeWireProviderId(p.id), p] as const));
  const rows: ProviderRequestFormatRow[] = [];
  const seen = new Set<string>();
  const add = (rawId: string, fallbackLabel?: string): void => {
    const id = normalizeWireProviderId(rawId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const catalog = catalogById.get(id);
    const savedNames = savedByProvider.get(id) ?? [];
    const label = catalog?.label ?? fallbackLabel ?? id;
    const bits = [`provider id: ${id}`];
    if (savedNames.length) bits.push(`saved as ${savedNames.join(', ')}`);
    rows.push({ id, label, savedNames, description: bits.join(' · ') });
  };

  for (const provider of PROVIDER_CATALOG) add(provider.id, provider.label);
  for (const id of savedByProvider.keys()) add(id);
  return rows;
}

export function applyProviderRequestFormat(config: CommandContext['config'], providerId: string, format: WireFormatOption): { ok: true } | { ok: false; error: string } {
  const id = normalizeWireProviderId(providerId);
  if (!id) return { ok: false, error: 'Provider id is required.' };
  if (!WIRE_FORMAT_OPTIONS.includes(format)) return { ok: false, error: `Unsupported wire format: ${format}` };

  const next: Record<string, WireFormatOverride> = { ...(config.cli?.providerRequestFormat ?? {}) };
  if (format === 'default') delete next[id];
  else next[id] = format;

  config.cli = { ...(config.cli ?? {}) };
  if (Object.keys(next).length === 0) delete config.cli.providerRequestFormat;
  else config.cli.providerRequestFormat = next;
  return { ok: true };
}
