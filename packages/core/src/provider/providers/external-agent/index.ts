import type { ProviderDefinition } from '../definition.js';

/**
 * ADR-047 D2 — the ENGINE provider: an installed coding-agent CLI drives the
 * main loop instead of an HTTP model. It has no endpoint and no API key; the
 * "model" id is the name of an entry in `cli.agents.hosted[]`, and the turn is
 * run as a subprocess (see `agent/transport/externalAgentEngine.ts`).
 *
 * `requestFormat: 'external-agent'` is what routes a turn to the subprocess
 * executor — resolved by provider id, before any endpoint/key logic. A user
 * lists their installed agents as this provider's `models` in config
 * (`providers.<name> = { provider: 'external-agent', model: 'ada', models: [...] }`),
 * exactly as they would list a normal provider's models — no live `/models`.
 *
 * It is a TERMINAL pick: the router never fails over to or from it, so a
 * subscription seat is never silently swapped for an API bill (handled in
 * `modelInvocationPhase`).
 */
export const externalAgent: ProviderDefinition = {
  id: 'external-agent',
  label: 'Coding agent (engine)',
  hint: 'an installed agent CLI drives the turn — model = a cli.agents.hosted name',
  endpoint: '',
  envKey: '',
  local: true,
  pickerVisible: true,
  requestFormat: 'external-agent',
  capabilities: ['chat'],
};
