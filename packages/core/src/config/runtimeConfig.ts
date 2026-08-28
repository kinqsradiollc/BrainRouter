/**
 * Runtime-plane configuration contracts and pure normalization.
 *
 * These shapes remain core-owned because they configure process, worktree,
 * container, and hosted execution adapters. They are re-exported by the
 * existing config barrel for compatibility.
 */

export type RuntimeBackendKind = 'process' | 'worktree' | 'container' | 'hosted';

export type HostedAgentProtocol = 'line-json' | 'stdio';

export interface HostedAgentConfig {
  name?: string;
  command?: string;
  args?: string[];
  protocol?: HostedAgentProtocol;
  /**
   * ADR-050 D5 — per-instance environment. The same agent CLI may appear under N
   * hosted entries (the entry `name` is the instance id / routing key), each with
   * an ISOLATED home so accounts never share auth state: `CLAUDE_CONFIG_DIR` /
   * `CODEX_HOME` / `GEMINI_*`, etc. Merged over `process.env` at spawn time.
   */
  env?: Record<string, string>;
}

export interface ResolvedHostedAgentConfig {
  name: string;
  command: string;
  args: string[];
  protocol: HostedAgentProtocol;
  /** ADR-050 D5 — resolved per-instance env (isolated home); absent ⇒ inherit process.env only. */
  env?: Record<string, string>;
}

export interface ContainerRuntimeLimits {
  /** `docker run --cpus` value (fractional allowed). 0/absent = no limit. */
  cpus?: number;
  /** `docker run --memory` value (e.g. '512m', '2g'). Empty/absent = no limit. */
  memory?: string;
}

export interface RuntimeCliKnobs {
  /** Defaults to `process`; invalid values normalize to `process`. */
  backend?: RuntimeBackendKind;
  /** Cap on concurrently live runtime instances. 0/absent means no cap. */
  maxLive?: number;
  /** Preserve throwaway-worktree changes in a durable archive. */
  archiveOnDispose?: boolean;
  /** Changed-file tarball cap in MB. */
  archiveMaxMB?: number;
  /** Number of newest archives retained. 0 disables count pruning. */
  archiveKeep?: number;
  /** Replace child-runtime secret values with short-lived lease tokens. */
  jitSecrets?: boolean;
  /** JIT secret lease lifetime in milliseconds. */
  jitSecretTtlMs?: number;
  /** Local image used by the opt-in container backend. */
  containerImage?: string;
  /** Resource limits applied to the container backend. */
  container?: ContainerRuntimeLimits;
  /** Serve the local runtime HTTP contract. */
  serve?: boolean;
  /** Local runtime contract bind host. */
  serveHost?: string;
  /** Local runtime contract port; 0 is allowed for tests. */
  servePort?: number;
  /** Remote runtime endpoint. */
  remoteUrl?: string;
  /** Named app-preview ports reserved by runtimes. */
  previewPorts?: Record<string, number>;
}

export function normalizeRuntimeBackend(value: unknown): RuntimeBackendKind {
  if (value === 'worktree') return 'worktree';
  if (value === 'container') return 'container';
  if (value === 'hosted') return 'hosted';
  return 'process';
}

const CONTAINER_MEMORY_RE = /^\d+(\.\d+)?[bkmg]?b?$/i;

export function normalizeContainerLimits(value: unknown): { cpus: number; memory: string } {
  const raw = (value && typeof value === 'object') ? value as ContainerRuntimeLimits : {};
  const cpus = typeof raw.cpus === 'number' && Number.isFinite(raw.cpus) && raw.cpus > 0
    ? Math.min(raw.cpus, 128)
    : 0;
  const memory = typeof raw.memory === 'string' && CONTAINER_MEMORY_RE.test(raw.memory.trim())
    ? raw.memory.trim()
    : '';
  return { cpus, memory };
}
