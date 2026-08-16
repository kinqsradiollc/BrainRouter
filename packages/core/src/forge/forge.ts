import type { PrRoute } from '../review/prRouter.js';
import type { CmdRunner } from '../git/prEmit.js';
import { changeRequestArgv } from '../review/prRouter.js';

export type ForgeId = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea';
export type ForgeCapability = 'change-request:create' | 'checks:list' | 'review:submit' | 'track:list';

export interface ForgeContext { remote: string; cwd: string; run: CmdRunner }
export interface ForgeProvider {
  id: ForgeId;
  cli?: string;
  capabilities: Record<ForgeCapability, boolean>;
  matches(remote: string): boolean;
  createChangeRequest?(ctx: ForgeContext, input: {
    base: string; head: string; title: string; body: string; draft: boolean;
    /** ADR-028 H1 — decided upstream so every caller lands on the same answer. */
    route?: PrRoute;
  }): { ok: boolean; stdout: string; stderr: string };
  listChecks?(ctx: ForgeContext, number: number): { ok: boolean; stdout: string; stderr: string };
  submitReview?(ctx: ForgeContext, number: number, action: 'approve' | 'comment' | 'request-changes', body: string): { ok: boolean; stdout: string; stderr: string };
  listTrack?(ctx: ForgeContext): { ok: boolean; stdout: string; stderr: string };
}

const full: Record<ForgeCapability, boolean> = { 'change-request:create': true, 'checks:list': true, 'review:submit': true, 'track:list': true };
const gated: Record<ForgeCapability, boolean> = { 'change-request:create': false, 'checks:list': false, 'review:submit': false, 'track:list': false };

const github: ForgeProvider = {
  id: 'github', cli: 'gh', capabilities: full,
  matches: (remote) => /github\.com[/:]/i.test(remote),
  // ADR-028 H2 — the chokepoint. A stack route submits through `gh stack`,
  // which registers the pull requests as a stack; anything else opens a plain
  // one, which stays correct and common.
  createChangeRequest: (ctx, input) => ctx.run(
    'gh',
    // The argv comes from `changeRequestArgv`, not from here. A shared ROUTE
    // was not enough: each site still assembled its own command, and the argv
    // is what drifts — `gh stack link` shipped and survived a ten-code exit
    // contract because an unknown subcommand exits 1 exactly like a real
    // command that failed.
    changeRequestArgv(input.route ?? { kind: 'single', reason: 'no route supplied' }, {
      title: input.title,
      body: input.body,
      ready: !input.draft,
      baseBranch: input.base,
      headBranch: input.head,
    }),
    ctx.cwd,
  ),
  listChecks: (ctx, number) => ctx.run('gh', ['pr', 'checks', String(number), '--json', 'name,state,bucket,link'], ctx.cwd),
  submitReview: (ctx, number, action, body) => ctx.run('gh', ['pr', 'review', String(number), action === 'approve' ? '--approve' : action === 'request-changes' ? '--request-changes' : '--comment', '--body', body], ctx.cwd),
  listTrack: (ctx) => ctx.run('gh', ['issue', 'list', '--json', 'number,title,state,url,labels,assignees'], ctx.cwd),
};

const gitlab: ForgeProvider = {
  id: 'gitlab', cli: 'glab', capabilities: full,
  matches: (remote) => /gitlab\.[^/:]+[/:]|gitlab\.com[/:]/i.test(remote),
  createChangeRequest: (ctx, input) => ctx.run('glab', ['mr', 'create', '--source-branch', input.head, '--target-branch', input.base, '--title', input.title, '--description', input.body, ...(input.draft ? ['--draft'] : []), '--yes'], ctx.cwd),
  listChecks: (ctx) => ctx.run('glab', ['ci', 'status'], ctx.cwd),
  submitReview: (ctx, number, action, body) => action === 'approve'
    ? ctx.run('glab', ['mr', 'approve', String(number)], ctx.cwd)
    : ctx.run('glab', ['mr', 'note', String(number), '--message', `${action === 'request-changes' ? 'Changes requested\n\n' : ''}${body}`], ctx.cwd),
  listTrack: (ctx) => ctx.run('glab', ['issue', 'list', '--output', 'json'], ctx.cwd),
};

const gatedProvider = (id: ForgeId, host: RegExp): ForgeProvider => ({ id, capabilities: { ...gated }, matches: (remote) => host.test(remote) });

export const FORGE_PROVIDERS: readonly ForgeProvider[] = [
  github,
  gitlab,
  gatedProvider('bitbucket', /bitbucket\./i),
  gatedProvider('azure-devops', /dev\.azure\.com|visualstudio\.com/i),
  gatedProvider('gitea', /gitea\./i),
];

export function detectForgeProvider(remote: string): ForgeProvider | undefined { return FORGE_PROVIDERS.find((provider) => provider.matches(remote)); }

export function forgeCapabilitySnapshot(remote: string): { forge?: ForgeId; capabilities: Record<ForgeCapability, boolean>; reason?: string } {
  const provider = detectForgeProvider(remote);
  return provider
    ? { forge: provider.id, capabilities: { ...provider.capabilities }, ...(provider.cli ? {} : { reason: 'provider-detected-but-operations-not-enabled' }) }
    : { capabilities: { ...gated }, reason: 'unknown-forge' };
}
