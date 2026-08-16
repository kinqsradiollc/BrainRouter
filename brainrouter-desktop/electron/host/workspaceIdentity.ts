/**
 * ADR-028 I3 — the identity check, at the point of writing.
 *
 * Placed on the WRITE path rather than in a settings screen, because the harm
 * this prevents happens at the moment of a push and nowhere else. A settings
 * page that records an intention does not stop the push that contradicts it.
 */
import { checkIdentity, bindWorkspace, type ForgeOperation, type IdentityVerdict } from '@kinqs/brainrouter-core/tooling';
import { readWorkspaceBinding, writeWorkspaceBinding } from './toolingState.js';

/** The `gh` runner, injected — it is a closure in the host, not a module. */
export type GhRunner = (
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ ok: boolean; stdout: string }>;

/**
 * Who `gh` is currently acting as.
 *
 * Parsed from `gh auth status` rather than kept in our own store, so what we
 * compare against is what git will actually use. A cached answer could be
 * stale, and a stale identity check is worse than none — it would say the push
 * is safe using an account that is no longer active.
 */
async function activeAccount(gh: GhRunner): Promise<{ login: string; host: string; active: true } | null> {
  const raw = await gh(['auth', 'status', '--active'], { timeout: 8_000 });
  if (!raw.ok) return null;
  const login = /account (\S+)/.exec(raw.stdout ?? '')?.[1];
  const host = /Logged in to (\S+)/.exec(raw.stdout ?? '')?.[1] ?? 'github.com';
  return login ? { login, host, active: true } : null;
}

export async function checkWorkspaceIdentity(
  workspaceRoot: string,
  operation: ForgeOperation,
  gh: GhRunner,
): Promise<IdentityVerdict> {
  const active = await activeAccount(gh);
  const verdict = checkIdentity({
    operation,
    active,
    binding: readWorkspaceBinding(workspaceRoot),
  });
  // The FIRST write binds rather than interrogating — a settings page nobody
  // visits is not where this belongs.
  if (verdict.kind === 'bind' && active) {
    writeWorkspaceBinding(bindWorkspace(workspaceRoot, active, new Date().toISOString()));
  }
  return verdict;
}
