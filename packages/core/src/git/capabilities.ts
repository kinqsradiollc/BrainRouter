import type { ExecutionHost } from '../exec/hosts.js';
import type { CmdRunner } from './prEmit.js';
import { randomBytes } from 'node:crypto';

export type GitCapability = 'cas-delete-ref' | 'merge-base-ancestor' | 'patch-equivalence' | 'worktree-remove-force';

export class GitCapabilityCache {
  private entries = new Map<string, { supported: boolean; checkedAt: number }>();
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(options: { retryMs?: number; now?: () => number } = {}) {
    this.retryMs = Math.max(1, options.retryMs ?? 30 * 60_000);
    this.now = options.now ?? Date.now;
  }

  private key(host: Pick<ExecutionHost, 'id'>, capability: GitCapability): string { return `${host.id}:${capability}`; }
  has(host: Pick<ExecutionHost, 'id'>, capability: GitCapability): boolean { return this.entries.get(this.key(host, capability))?.supported ?? false; }
  invalidate(host: Pick<ExecutionHost, 'id'>, capability: GitCapability): void { this.entries.delete(this.key(host, capability)); }

  /** Behavior-probe once per execution host. Unsupported results are retried
   * after the TTL, so an upgraded remote/WSL Git self-heals without a restart. */
  supports(host: Pick<ExecutionHost, 'id'>, capability: GitCapability, probe: () => boolean): boolean {
    const key = this.key(host, capability);
    const existing = this.entries.get(key);
    const now = this.now();
    if (existing?.supported) return true;
    if (existing && now - existing.checkedAt < this.retryMs) return false;
    const supported = probe();
    this.entries.set(key, { supported, checkedAt: now });
    return supported;
  }

  /** Compatibility helper for operation-level callers; failures are timestamped
   * and will be retried after the same self-healing interval. */
  run<T>(host: Pick<ExecutionHost, 'id'>, capability: GitCapability, attempt: () => { ok: boolean; value: T }): { supported: boolean; value: T } {
    const result = attempt();
    this.entries.set(this.key(host, capability), { supported: result.ok, checkedAt: this.now() });
    return { supported: result.ok, value: result.value };
  }
}

export interface BranchPreservationProof {
  safe: boolean;
  reason: 'ancestor' | 'tree-equivalent' | 'patch-equivalent' | 'unabsorbed-commits' | 'missing-ref' | 'no-destination' | 'checked-out';
  candidateOid?: string;
  destination?: string;
}

function safeRef(value: string): boolean { return !!value && !value.startsWith('-') && !/[\s\0\r\n]/.test(value); }

export function proveBranchPreserved(run: CmdRunner, cwd: string, candidate: string, destinations: string[]): BranchPreservationProof {
  if (!safeRef(candidate)) return { safe: false, reason: 'missing-ref' };
  const oid = run('git', ['rev-parse', '--verify', candidate], cwd);
  if (!oid.ok || !/^[a-f0-9]{40,64}$/i.test(oid.stdout.trim())) return { safe: false, reason: 'missing-ref' };
  const candidateOid = oid.stdout.trim();
  const worktrees = run('git', ['worktree', 'list', '--porcelain'], cwd);
  if (worktrees.ok && worktrees.stdout.split(/\r?\n/).some((line) => line.trim() === `branch ${candidate}`)) {
    return { safe: false, reason: 'checked-out', candidateOid };
  }
  const refs = destinations.filter(safeRef);
  if (!refs.length) return { safe: false, reason: 'no-destination', candidateOid };
  for (const destination of refs) {
    if (run('git', ['merge-base', '--is-ancestor', candidateOid, destination], cwd).ok) return { safe: true, reason: 'ancestor', candidateOid, destination };
    if (run('git', ['diff', '--quiet', `${candidateOid}^{tree}`, `${destination}^{tree}`], cwd).ok) return { safe: true, reason: 'tree-equivalent', candidateOid, destination };
    const cherry = run('git', ['cherry', destination, candidateOid], cwd);
    if (cherry.ok && cherry.stdout.split('\n').filter(Boolean).every((line) => line.startsWith('-'))) return { safe: true, reason: 'patch-equivalent', candidateOid, destination };
  }
  return { safe: false, reason: 'unabsorbed-commits', candidateOid };
}

export function deleteRefCas(run: CmdRunner, cwd: string, ref: string, expectedOid: string, cache = new GitCapabilityCache(), host: Pick<ExecutionHost, 'id'> = { id: 'local' }): { ok: boolean; error?: string } {
  if (!ref.startsWith('refs/heads/') || !safeRef(ref) || !/^[a-f0-9]{40,64}$/i.test(expectedOid)) return { ok: false, error: 'unsafe-ref-or-oid' };
  const supported = cache.supports(host, 'cas-delete-ref', () => {
    const head = run('git', ['rev-parse', '--verify', 'HEAD'], cwd);
    if (!head.ok || !/^[a-f0-9]{40,64}$/i.test(head.stdout.trim())) return false;
    const probeRef = `refs/brainrouter/probes/cas-${randomBytes(6).toString('hex')}`;
    const zero = '0'.repeat(head.stdout.trim().length);
    const created = run('git', ['update-ref', probeRef, head.stdout.trim(), zero], cwd);
    if (!created.ok) return false;
    const deleted = run('git', ['update-ref', '-d', probeRef, head.stdout.trim()], cwd);
    if (!deleted.ok) run('git', ['update-ref', '-d', probeRef], cwd);
    return deleted.ok;
  });
  if (!supported) return { ok: false, error: 'cas-delete-unsupported' };
  const deleted = run('git', ['update-ref', '-d', ref, expectedOid], cwd);
  return deleted.ok ? { ok: true } : { ok: false, error: deleted.stderr.trim() || 'cas-delete-ref-moved' };
}

export function safeDeleteBranch(input: { run: CmdRunner; cwd: string; branch: string; destinations: string[]; cache?: GitCapabilityCache; host?: Pick<ExecutionHost, 'id'> }): { ok: boolean; proof: BranchPreservationProof; error?: string } {
  const ref = input.branch.startsWith('refs/heads/') ? input.branch : `refs/heads/${input.branch}`;
  const proof = proveBranchPreserved(input.run, input.cwd, ref, input.destinations);
  if (!proof.safe || !proof.candidateOid) return { ok: false, proof, error: 'commit-preservation-not-proven' };
  const short = ref.slice('refs/heads/'.length);
  if (proof.reason === 'ancestor') {
    const normal = input.run('git', ['branch', '-d', '--', short], input.cwd);
    if (normal.ok) return { ok: true, proof };
  }
  const deleted = deleteRefCas(input.run, input.cwd, ref, proof.candidateOid, input.cache, input.host);
  return { ...deleted, proof };
}
