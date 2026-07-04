import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { brainrouterHome } from './paths.js';

export interface OrgConventionOwner {
  provider: string;
  login: string;
  kind: 'user' | 'org';
}

export interface OrgConventionProvider {
  provider: string;
  listOwners(): Promise<OrgConventionOwner[]>;
  conventionRepoRoot(owner: OrgConventionOwner, repoName: string): Promise<string | null>;
}

export interface OrgConventionRepo {
  owner: OrgConventionOwner;
  root: string;
}

export interface OrgConventionDiscoveryOptions {
  enabled: boolean;
  providers: OrgConventionProvider[];
  repoName?: string;
}

export interface OrgConventionDiscoveryResult {
  repos: OrgConventionRepo[];
  warnings: string[];
}

let orgConventionRoots: string[] = [];

export function setOrgConventionRepoRoots(roots: string[]): void {
  orgConventionRoots = uniqueExistingDirs(roots);
}

export function getOrgConventionRepoRoots(): string[] {
  return [...orgConventionRoots];
}

export function clearOrgConventionRepoRoots(): void {
  orgConventionRoots = [];
}

export async function refreshOrgConventionRepoRoots(options: OrgConventionDiscoveryOptions): Promise<OrgConventionDiscoveryResult> {
  const result = await discoverOrgConventionRepos(options);
  setOrgConventionRepoRoots(result.repos.map((repo) => repo.root));
  return result;
}

export async function discoverOrgConventionRepos(options: OrgConventionDiscoveryOptions): Promise<OrgConventionDiscoveryResult> {
  if (!options.enabled) return { repos: [], warnings: [] };

  const repoName = options.repoName ?? '.brainrouter';
  const warnings: string[] = [];
  const repos: OrgConventionRepo[] = [];
  const seenOwners = new Set<string>();
  const seenRoots = new Set<string>();

  for (const provider of options.providers) {
    let owners: OrgConventionOwner[];
    try {
      owners = await provider.listOwners();
    } catch (err) {
      warnings.push(`${provider.provider}: ${errorMessage(err)}`);
      continue;
    }

    for (const owner of owners) {
      const login = owner.login.trim();
      if (!login) continue;
      const normalized: OrgConventionOwner = {
        provider: owner.provider || provider.provider,
        login,
        kind: owner.kind,
      };
      const ownerKey = `${normalized.provider}:${normalized.login.toLowerCase()}`;
      if (seenOwners.has(ownerKey)) continue;
      seenOwners.add(ownerKey);

      let root: string | null;
      try {
        root = await provider.conventionRepoRoot(normalized, repoName);
      } catch (err) {
        warnings.push(`${normalized.provider}:${normalized.login}: ${errorMessage(err)}`);
        continue;
      }
      if (!root) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(root);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const resolved = path.resolve(root);
      if (seenRoots.has(resolved)) continue;
      seenRoots.add(resolved);
      repos.push({ owner: normalized, root: resolved });
    }
  }

  return { repos, warnings };
}

export interface GhCliConventionProviderOptions {
  command?: string;
  cacheRoot?: string;
  timeoutMs?: number;
}

export function createGhCliOrgConventionProvider(options: GhCliConventionProviderOptions = {}): OrgConventionProvider {
  const command = options.command ?? 'gh';
  const cacheRoot = options.cacheRoot ?? path.join(brainrouterHome(), 'org-conventions', 'github');
  const timeoutMs = options.timeoutMs ?? 20_000;

  const runJson = async <T>(args: string[]): Promise<T> => {
    const text = await run(command, args, { timeoutMs });
    return JSON.parse(text) as T;
  };

  return {
    provider: 'github',
    async listOwners(): Promise<OrgConventionOwner[]> {
      const owners: OrgConventionOwner[] = [];
      const viewer = await runJson<{ login?: string }>(['api', 'user']);
      if (viewer.login?.trim()) owners.push({ provider: 'github', login: viewer.login.trim(), kind: 'user' });
      const orgs = await runJson<Array<{ login?: string }>>(['api', 'user/orgs?per_page=100']);
      for (const org of orgs) {
        const login = org.login?.trim();
        if (login) owners.push({ provider: 'github', login, kind: 'org' });
      }
      return owners;
    },
    async conventionRepoRoot(owner: OrgConventionOwner, repoName: string): Promise<string | null> {
      const repo = `${owner.login}/${repoName}`;
      try {
        await run(command, ['repo', 'view', repo, '--json', 'nameWithOwner'], { timeoutMs });
      } catch {
        return null;
      }

      const dest = path.join(cacheRoot, safePathPart(owner.login), repoName);
      if (isGitCheckout(dest)) {
        try {
          await run('git', ['-C', dest, 'pull', '--ff-only', '--quiet'], { timeoutMs });
        } catch {
          // Keep the existing read-only cache when refresh is unavailable.
        }
        return dest;
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        await run(command, ['repo', 'clone', repo, dest, '--', '--depth=1'], { timeoutMs });
        return dest;
      } catch {
        return null;
      }
    },
  };
}

function uniqueExistingDirs(roots: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function safePathPart(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isGitCheckout(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  // Org discovery shells out to the GitHub CLI; its stderr can be multi-line and
  // (rarely) echo request context. Surface only the first line, length-capped,
  // so a discovery warning can never carry a token dump into a log.
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n', 1)[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

function run(command: string, args: string[], opts: { timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} ${args[0] ?? ''} timed out`));
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with ${code ?? 'unknown status'}`));
    });
  });
}
