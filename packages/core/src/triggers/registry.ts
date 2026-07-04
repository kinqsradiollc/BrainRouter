/**
 * MC-B1 — trigger provider registry. The ingress server looks providers up
 * by URL segment; anything not registered here 404s (default-deny). MC-B7
 * adds gitlab/jira by registering more adapters — no server change needed.
 */
import type { TriggerProvider } from './triggerTypes.js';
import { githubTriggerProvider } from './providers/github.js';
import { slackTriggerProvider } from './providers/slack.js';

const providers = new Map<string, TriggerProvider>();

/** Register (or replace) a provider adapter. Name is the URL path segment. */
export function registerTriggerProvider(provider: TriggerProvider): void {
  const name = provider.name.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid trigger provider name: ${provider.name}`);
  }
  providers.set(name, provider);
}

/** Look a provider up by its URL segment; undefined → the server 404s. */
export function getTriggerProvider(name: string): TriggerProvider | undefined {
  return providers.get(name.trim().toLowerCase());
}

/** Registered provider names (for diagnostics/CLI output). */
export function listTriggerProviders(): string[] {
  return [...providers.keys()].sort();
}

// Built-ins.
registerTriggerProvider(githubTriggerProvider);
registerTriggerProvider(slackTriggerProvider);
