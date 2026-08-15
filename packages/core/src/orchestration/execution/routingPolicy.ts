/**
 * Private routing-policy capture for reviewed durable execution.
 *
 * The live config remains the source of child/critic routing, but a reviewed
 * launch must fail closed when that source changes. This module fingerprints
 * only routing-relevant provider metadata and role assignments; credential
 * values never enter the captured shape. File identity/timestamps additionally
 * make an A-to-B-to-A edit observable without persisting config content.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  getConfigPath,
  loadOrInitConfig,
  resolveCliKnobs,
  type Config,
  type LLMConfig,
} from '../../config/config.js';

interface ConfigFileRevision {
  path: string;
  exists: boolean;
  device?: string;
  inode?: string;
  size?: string;
  modifiedNs?: string;
  changedNs?: string;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '"<undefined>"';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(String(value));
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => (
    `${JSON.stringify(key)}:${canonicalJson(child)}`
  )).join(',')}}`;
}

function configFileRevision(): ConfigFileRevision {
  const configPath = getConfigPath();
  try {
    const stat = fs.statSync(configPath, { bigint: true });
    return {
      path: configPath,
      exists: true,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size: stat.size.toString(),
      modifiedNs: stat.mtimeNs.toString(),
      changedNs: stat.ctimeNs.toString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: configPath, exists: false };
    }
    throw error;
  }
}

function providerRoutingShape(config: LLMConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    model: config.model,
    endpoint: config.endpoint ?? null,
    models: config.models ?? null,
    apiVersion: config.apiVersion ?? null,
    free: config.free === true,
    passthroughUnknown: config.passthroughUnknown === true,
    cachedModels: config.cachedModels ?? null,
    cachedAt: config.cachedAt ?? null,
    credentialConfigured:
      typeof config.apiKey === 'string' && config.apiKey.trim().length > 0,
  };
}

/**
 * Pure testable projection. `revision` proves the config source was not edited;
 * `config` contributes only fields that can select or invoke a child/critic
 * route. In particular, no API-key value enters the digest.
 */
export function executionRoutingPolicyFingerprintFor(
  config: Config,
  revision: ConfigFileRevision,
): string {
  const knobs = resolveCliKnobs(config);
  const providers = Object.fromEntries(
    Object.entries(config.providers ?? {}).map(([name, provider]) => (
      [name, providerRoutingShape(provider)]
    )),
  );
  const agentModels = Object.fromEntries(
    Object.entries(config.agentModels ?? {}).map(([role, assignment]) => [
      role,
      {
        provider: assignment.provider ?? null,
        model: assignment.model ?? null,
      },
    ]),
  );
  return createHash('sha256')
    .update(canonicalJson({
      revision,
      providers,
      agentModels,
      router: {
        aliases: knobs.router.aliases,
        chain: knobs.router.chain,
        order: knobs.router.order,
        strategy: knobs.router.strategy,
        passThrough: knobs.router.passThrough,
        fallbackModels: knobs.fallbackModels,
        availableModels: knobs.availableModels,
        enforceAvailableModels: knobs.enforceAvailableModels,
      },
      criticModel: knobs.critic.model,
    }))
    .digest('hex');
}

/** Capture one stable routing-policy revision from the live config file. */
export function executionRoutingPolicyFingerprint(): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = configFileRevision();
    const config = loadOrInitConfig();
    const after = configFileRevision();
    if (canonicalJson(before) === canonicalJson(after)) {
      return executionRoutingPolicyFingerprintFor(config, after);
    }
  }
  throw new Error(
    'Workflow launch canceled because model-routing config changed during review.',
  );
}
