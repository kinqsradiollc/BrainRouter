/**
 * host/github-track-services — the desktop host's GitHub / connector / Track-PR
 * service layer.
 *
 * These are the `main()`-local service builders that used to sit inline in
 * host.ts: the gh-CLI runners (ghText/ghJson + env), connector credential
 * resolution + checkpoint/permission runs, and the Track↔GitHub pull-request
 * workflow (draft PR, import issues, merge, review, fix-CI). Bodies are
 * unchanged; the two `main()`-local bindings they mutate/read across the process
 * lifetime — the PR cache and the viewed agent — are threaded through `deps`.
 *
 * host.ts calls `buildGithubTrackServices(deps)` once and folds the returned
 * functions into its HostContext (and clears the scheduler timers on shutdown).
 */
import { execFile } from 'node:child_process';
import type { Agent } from '@kinqs/brainrouter-core/agent';
import { loadConfig } from '@kinqs/brainrouter-core/config';
import type { BackgroundTaskRecord } from '@kinqs/brainrouter-types';
import type { AgentLike } from '../hostCore.js';
import { mergeGithubCliEnv, normalizeGithubCliError } from '../ghCli.js';
import { git, type TrackGithubConfig, type SecretBridge } from './helpers.js';
import { createBackgroundTask, updateBackgroundTask } from '@kinqs/brainrouter-core/background';
import {
  ensureProject,
  getProject,
  getWorkItem,
  listWorkItems,
  createWorkItem,
  transitionWorkItem,
  updateWorkItem,
  linkWorkItem,
  getGithubLinks,
  setGithubLink,
} from '@kinqs/brainrouter-core/track';
import { issueToWorkItem, type GithubIssue } from '@kinqs/brainrouter-core/track';
import {
  finishConnectorRun,
  getConnector,
  listConnectors,
  recordConnectorRun,
  updateConnector,
  exportConnectorDocumentsForMemory,
  upsertConnectorDocuments,
  upsertConnectorPermissions,
  buildCheckpointRunner,
  runGithubConnectorPermissionSync,
  validateGithubConnectorAccess,
  type GithubConnectorClient,
  type GithubConnectorPermissionClient,
  type GithubConnectorValidationClient,
  type McpConnectorClient,
  type McpConnectorResource,
} from '@kinqs/brainrouter-core/connectors';
import type { McpClientPool } from '@kinqs/brainrouter-core/mcp';
import type { TrackPrView } from './context.js';

/** The `main()`-local runtime the GitHub/Track services close over. */
export interface GithubTrackDeps {
  workspaceRoot: string;
  mcpClient: McpClientPool;
  secretBridge: SecretBridge | undefined;
  spawnTaskAgent: (sessionKey: string, access: 'read' | 'write') => AgentLike;
  emitTaskEvent: (action: 'created' | 'progress' | 'updated' | 'completed' | 'failed' | 'canceled', t: BackgroundTaskRecord) => void;
  taskProgress: (id: string, phase: string, note?: string) => void;
  // Live accessors for the two reassigned bindings the services touch.
  getActiveAgent: () => Agent;
  setPrCache: (v: { at: number; pr: { number: number; state: string; title?: string } | null } | null) => void;
}

export function buildGithubTrackServices(deps: GithubTrackDeps) {
  const {
    workspaceRoot,
    mcpClient,
    secretBridge,
    spawnTaskAgent,
    emitTaskEvent,
    taskProgress,
    getActiveAgent,
    setPrCache,
  } = deps;

  type TrackPrView = {
    number?: number; state?: string; title?: string; url?: string;
    headRefName?: string; baseRefName?: string; isDraft?: boolean;
    mergeable?: string; statusCheckRollup?: unknown[];
  };

  type GhResult = { ok: boolean; stdout: string; stderr: string; error?: string };
  let ghEnvCache: { at: number; env: NodeJS.ProcessEnv } | null = null;

  const ghEnv = async (): Promise<NodeJS.ProcessEnv> => {
    const now = Date.now();
    if (ghEnvCache && now - ghEnvCache.at < 60_000) return ghEnvCache.env;
    const cli = (loadConfig() as { cli?: { track?: TrackGithubConfig; github?: { caBundle?: string } } }).cli ?? {};
    // Global home first (cli.github.caBundle); the old track-scoped knob stays a
    // read fallback so existing configs keep working.
    const configuredCA = cli.github?.caBundle?.trim() || cli.track?.githubCaBundle?.trim() || undefined;
    const [sslCAInfo, sslCAPath] = await Promise.all([
      git(['config', '--get', 'http.sslCAInfo'], workspaceRoot),
      git(['config', '--get', 'http.sslCAPath'], workspaceRoot),
    ]);
    const env = mergeGithubCliEnv(process.env, {
      sslCAInfo: configuredCA || sslCAInfo.trim() || undefined,
      sslCAPath: sslCAPath.trim() || undefined,
    });
    ghEnvCache = { at: now, env };
    return env;
  };

  const ghText = async (args: string[], opts?: { timeout?: number; maxBuffer?: number }): Promise<GhResult> => new Promise((resolve) => {
    ghEnv().then((env) => {
      execFile('gh', args, { cwd: workspaceRoot, env, encoding: 'utf-8', timeout: opts?.timeout ?? 10_000, maxBuffer: opts?.maxBuffer ?? 2_000_000 },
        (err, stdout, stderr) => {
          const stderrText = String(stderr ?? '');
          resolve({
            ok: !err,
            stdout: String(stdout ?? ''),
            stderr: stderrText,
            error: err ? normalizeGithubCliError(stderrText, `gh ${args.slice(0, 2).join(' ')} failed.`) : undefined,
          });
        });
    }).catch((err) => resolve({ ok: false, stdout: '', stderr: String(err instanceof Error ? err.message : err), error: String(err instanceof Error ? err.message : err) }));
  });

  const ghJson = async <T,>(args: string[], opts?: { timeout?: number; maxBuffer?: number; allowNonZeroJson?: boolean }): Promise<{ data?: T; error?: string }> => {
    const res = await ghText(args, opts);
    let data: T | undefined;
    if (res.stdout.trim()) {
      try { data = JSON.parse(res.stdout) as T; }
      catch { return { error: 'GitHub CLI returned invalid JSON.' }; }
    }
    if (!res.ok && !(opts?.allowNonZeroJson && data !== undefined)) return { error: res.error ?? 'GitHub CLI command failed.' };
    if (data !== undefined) return { data };
    if (!res.ok) return { error: res.error ?? 'GitHub CLI command failed.' };
    try { return { data: JSON.parse(res.stdout) as T }; }
    catch { return { error: 'GitHub CLI returned invalid JSON.' }; }
  };

  const githubApiBase = (connector: { config?: Record<string, unknown> }): string => {
    const raw = typeof connector.config?.baseUrl === 'string' ? connector.config.baseUrl.trim() : '';
    return (raw || 'https://api.github.com').replace(/\/+$/, '');
  };

  const githubStaticToken = (connector: { credential?: { mode?: string; ref?: string } }): { token?: string; error?: string } => {
    if (connector.credential?.mode !== 'static') return {};
    const ref = connector.credential.ref?.trim();
    if (!ref) return { error: 'Static GitHub connector credential reference is required.' };
    // `config:track` — the migrated-legacy scheme (connector Phase 0): the token
    // still lives in cli.track.githubToken until the Phase 3 keychain move.
    if (ref === 'config:track') {
      const track = ((loadConfig() as { cli?: { track?: TrackGithubConfig } }).cli?.track) ?? {};
      const token = track.githubToken?.trim();
      if (!token) return { error: 'The migrated GitHub token is no longer in config.json. Re-add a token in Settings → Connectors → GitHub.' };
      return { token };
    }
    const token = process.env[ref]?.trim();
    if (!token) return { error: `Static GitHub connector credential ${ref} is not available in the host environment.` };
    return { token };
  };

  /**
   * Connector Phase 2 — mode-aware credential resolution. `static` resolves
   * locally (env / config:track); `oauth` fetches the device-flow token from
   * the MAIN process keychain over the secret bridge. Never returns to the
   * renderer.
   */
  const githubConnectorToken = async (connector: { id: string; credential?: { mode?: string; ref?: string } }): Promise<{ token?: string; error?: string }> => {
    if (connector.credential?.mode === 'oauth') {
      if (!secretBridge) return { error: 'Keychain access requires the Electron app (dev host has no secret bridge).' };
      try {
        const token = await secretBridge.get(`connector:${connector.id}:github-oauth`);
        if (!token) return { error: 'No OAuth token stored for this connector — connect the GitHub account in Settings → Connectors.' };
        return { token };
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      }
    }
    return githubStaticToken(connector);
  };

  const connectorEnvToken = (connector: { credential?: { mode?: string; ref?: string } }, label: string): { token?: string; error?: string } => {
    if (!connector.credential || connector.credential.mode === 'none') return {};
    if (connector.credential.mode !== 'static') return { error: `${label} connector currently supports static environment-token credentials only.` };
    const ref = connector.credential.ref?.trim();
    if (!ref) return { error: `${label} connector credential reference is required.` };
    const token = process.env[ref]?.trim();
    if (!token) return { error: `${label} connector credential ${ref} is not available in the host environment.` };
    return { token };
  };

  // `connectorConfigString` / `requireConnectorConfig` / `filesystemConnectorForHost`
  // moved into core's shared runner (`buildCheckpointRunner`), which now performs
  // per-source config validation + relative-root resolution for the host too.

  const mcpConnectorClient = (): McpConnectorClient => ({
    async listResources(opts) {
      const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
      if (opts.resourceUris?.length) {
        if (!opts.serverId) throw new Error('MCP connector config serverId is required when resourceUris are configured.');
        return opts.resourceUris.slice(0, limit).map((uri) => ({ server: opts.serverId, uri }));
      }
      const resources: McpConnectorResource[] = [];
      let cursor: string | undefined;
      do {
        const result = await mcpClient.listResources({ server: opts.serverId, cursor });
        const rows = Array.isArray((result as { resources?: unknown[] }).resources) ? (result as { resources: unknown[] }).resources : [];
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          const r = row as Record<string, unknown>;
          const uri = typeof r.uri === 'string' ? r.uri : '';
          if (!uri) continue;
          resources.push({
            server: typeof r.server === 'string' ? r.server : opts.serverId,
            uri,
            name: typeof r.name === 'string' ? r.name : undefined,
            description: typeof r.description === 'string' ? r.description : undefined,
            mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
          });
          if (resources.length >= limit) break;
        }
        cursor = typeof (result as { nextCursor?: unknown }).nextCursor === 'string' ? (result as { nextCursor: string }).nextCursor : undefined;
      } while (cursor && resources.length < limit);
      return resources;
    },
    async readResource(resource) {
      if (!resource.server) throw new Error(`MCP resource ${resource.uri} has no server id.`);
      const result = await mcpClient.readResource({ server: resource.server, uri: resource.uri });
      const contents = Array.isArray((result as { contents?: unknown[] }).contents) ? (result as { contents: unknown[] }).contents : [];
      return {
        contents: contents.map((content) => {
          const row = content && typeof content === 'object' ? content as Record<string, unknown> : {};
          return {
            uri: typeof row.uri === 'string' ? row.uri : undefined,
            text: typeof row.text === 'string' ? row.text : undefined,
            blob: typeof row.blob === 'string' ? row.blob : undefined,
            mimeType: typeof row.mimeType === 'string' ? row.mimeType : undefined,
          };
        }),
      };
    },
  });

  // Connector checkpoint runtime — DELEGATES to core's shared `buildCheckpointRunner`
  // (the single per-source switch now lives in packages/core so the agent/CLI/MCP
  // share it). The host contributes only what core can't build alone: its
  // keychain/gh-CLI-aware GitHub client, its connected MCP client, its static
  // env-token resolver, and the workspace root (for relative filesystem roots).
  // `filesystemConnectorForHost`'s root resolution is now performed inside the
  // shared runner via `workspaceRoot`, so behavior is unchanged for all 12 sources.
  const runConnectorCheckpoint = buildCheckpointRunner({
    githubClient: () => githubConnectorClient(),
    mcpClient: () => mcpConnectorClient(),
    envToken: (connector, label) => connectorEnvToken(connector, label),
    workspaceRoot,
  });

  const githubTokenJson = async <T,>(connector: { config?: Record<string, unknown> }, token: string, apiPath: string): Promise<T> => {
    const res = await fetch(`${githubApiBase(connector)}${apiPath}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'BrainRouter-Desktop',
      },
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json() as { message?: string };
        detail = body.message ? `: ${body.message}` : '';
      } catch {
        detail = '';
      }
      throw new Error(`GitHub API ${res.status}${detail}`);
    }
    return await res.json() as T;
  };

  const currentGitBranch = async (): Promise<string | null> => {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot)).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  };

  const trackItemForBranch = (branch: string): { id: string; key: string } | undefined =>
    listWorkItems(workspaceRoot).find((item) => item.codeLinks.some((link) => link.kind === 'branch' && link.ref === branch));

  const readTrackPrStatus = async (): Promise<{ pr: TrackPrView | null; branch: string | null; itemKey?: string; error?: string }> => {
    const branch = await currentGitBranch();
    const item = branch ? trackItemForBranch(branch) : undefined;
    const detail = await ghJson<TrackPrView>(['pr', 'view', '--json', 'number,state,title,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup'], { timeout: 8_000 });
    if (detail.error) return { pr: null, branch, itemKey: item?.key, error: detail.error };
    return { pr: detail.data ?? null, branch, itemKey: item?.key };
  };

  const githubGhValidationClient = (): GithubConnectorValidationClient => ({
    async listRepositories(owner, opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
      const listed = await ghJson<Array<{ nameWithOwner?: string }>>(['repo', 'list', owner, '--limit', String(limit), '--json', 'nameWithOwner'], { timeout: 12_000, maxBuffer: 500_000 });
      if (listed.error) throw new Error(listed.error);
      return (listed.data ?? []).map((repo) => repo.nameWithOwner ?? '').filter(Boolean);
    },
    async getRepository(repo) {
      const view = await ghJson<{ nameWithOwner?: string }>(['repo', 'view', repo, '--json', 'nameWithOwner'], { timeout: 10_000, maxBuffer: 500_000 });
      if (view.error) throw new Error(view.error);
      return view.data?.nameWithOwner ?? repo;
    },
  });

  const githubTokenValidationClient = (connector: { config?: Record<string, unknown> }, token: string): GithubConnectorValidationClient => ({
    async listRepositories(owner, opts) {
      const limit = Math.max(1, Math.min(100, opts?.limit ?? 100));
      try {
        const orgRepos = await githubTokenJson<Array<{ full_name?: string }>>(connector, token, `/orgs/${encodeURIComponent(owner)}/repos?per_page=${limit}`);
        if (orgRepos.length) return orgRepos.map((repo) => repo.full_name ?? '').filter(Boolean);
      } catch {
        // Fall through to the user endpoint; the owner may be a personal account.
      }
      const userRepos = await githubTokenJson<Array<{ full_name?: string }>>(connector, token, `/users/${encodeURIComponent(owner)}/repos?per_page=${limit}`);
      return userRepos.map((repo) => repo.full_name ?? '').filter(Boolean);
    },
    async getRepository(repo) {
      const data = await githubTokenJson<{ full_name?: string }>(connector, token, `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`);
      return data.full_name ?? repo;
    },
  });

  const githubGhPermissionClient = (): GithubConnectorPermissionClient => ({
    async listRepositories(owner, opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
      const listed = await ghJson<Array<{ nameWithOwner?: string }>>(['repo', 'list', owner, '--limit', String(limit), '--json', 'nameWithOwner'], { timeout: 20_000, maxBuffer: 4_000_000 });
      if (listed.error) throw new Error(listed.error);
      return (listed.data ?? []).map((repo) => repo.nameWithOwner ?? '').filter(Boolean);
    },
    async listCollaborators(repo) {
      const collaborators = await ghJson<Array<{ login?: string; name?: string | null; html_url?: string; role_name?: string; permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean } }>>(
        ['api', `repos/${repo}/collaborators?affiliation=all&per_page=100`],
        { timeout: 20_000, maxBuffer: 4_000_000 },
      );
      if (collaborators.error) throw new Error(collaborators.error);
      return (collaborators.data ?? [])
        .filter((collaborator) => typeof collaborator.login === 'string' && collaborator.login.trim().length > 0)
        .map((collaborator) => ({
          login: collaborator.login!,
          name: collaborator.name,
          htmlUrl: collaborator.html_url,
          roleName: collaborator.role_name,
          permissions: collaborator.permissions,
        }));
    },
  });

  const githubTokenPermissionClient = (connector: { config?: Record<string, unknown> }, token: string): GithubConnectorPermissionClient => ({
    async listRepositories(owner, opts) {
      return githubTokenValidationClient(connector, token).listRepositories(owner, opts);
    },
    async listCollaborators(repo) {
      const collaborators = await githubTokenJson<Array<{ login?: string; name?: string | null; html_url?: string; role_name?: string; permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean } }>>(
        connector,
        token,
        `/repos/${repo.split('/').map(encodeURIComponent).join('/')}/collaborators?affiliation=all&per_page=100`,
      );
      return collaborators
        .filter((collaborator) => typeof collaborator.login === 'string' && collaborator.login.trim().length > 0)
        .map((collaborator) => ({
          login: collaborator.login!,
          name: collaborator.name,
          htmlUrl: collaborator.html_url,
          roleName: collaborator.role_name,
          permissions: collaborator.permissions,
        }));
    },
  });

  const validateGithubConnector = async (connectorId: string): Promise<{ ok: boolean; checked: string[]; errors: string[]; connector: unknown | null }> => {
    const connector = getConnector(workspaceRoot, connectorId);
    if (!connector) return { ok: false, checked: [], errors: ['Connector not found.'], connector: null };
    let result: { ok: boolean; checked: string[]; errors: string[] };
    if (connector.credential.mode === 'static') {
      const credential = githubStaticToken(connector);
      result = credential.token
        ? await validateGithubConnectorAccess(connector, githubTokenValidationClient(connector, credential.token))
        : { ok: false, checked: [], errors: [credential.error ?? 'Static GitHub connector credential is not available.'] };
    } else {
      result = await validateGithubConnectorAccess(connector, githubGhValidationClient());
    }
    const updated = updateConnector(workspaceRoot, connector.id, {
      status: result.ok ? 'active' : 'error',
      lastError: result.ok ? undefined : result.errors[0] ?? 'GitHub connector validation failed.',
    }) ?? connector;
    return { ...result, connector: updated };
  };

  const githubConnectorClient = (): GithubConnectorClient => ({
    async listRepositories(owner, opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
      const listed = await ghJson<Array<{ nameWithOwner?: string }>>(['repo', 'list', owner, '--limit', String(limit), '--json', 'nameWithOwner'], { timeout: 20_000, maxBuffer: 4_000_000 });
      if (listed.error) throw new Error(listed.error);
      return (listed.data ?? []).map((repo) => repo.nameWithOwner ?? '').filter(Boolean);
    },
    async listIssues(repo, opts) {
      const args = ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,url,updatedAt,labels,assignees'];
      if (opts?.since) args.push('--search', `updated:>=${opts.since}`);
      const issues = await ghJson<unknown[]>(args, { timeout: 20_000, maxBuffer: 6_000_000 });
      if (issues.error) throw new Error(issues.error);
      return (issues.data ?? []) as never;
    },
    async listPullRequests(repo, opts) {
      const args = ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,url,updatedAt,author'];
      if (opts?.since) args.push('--search', `updated:>=${opts.since}`);
      const pulls = await ghJson<unknown[]>(args, { timeout: 20_000, maxBuffer: 6_000_000 });
      if (pulls.error) throw new Error(pulls.error);
      return (pulls.data ?? []) as never;
    },
    async listFiles(repo) {
      const tree = await ghJson<{ tree?: Array<{ path?: string; type?: string; sha?: string; size?: number; url?: string }> }>(
        ['api', `repos/${repo}/git/trees/HEAD?recursive=1`],
        { timeout: 20_000, maxBuffer: 10_000_000 },
      );
      if (tree.error) throw new Error(tree.error);
      const blobs = (tree.data?.tree ?? []).filter((entry) => entry.type === 'blob' && entry.path).slice(0, 100);
      const files = [];
      for (const blob of blobs) {
        const pathName = blob.path ?? '';
        const content = await ghJson<{ content?: string; encoding?: string; html_url?: string }>(
          ['api', `repos/${repo}/contents/${pathName.split('/').map(encodeURIComponent).join('/')}`],
          { timeout: 10_000, maxBuffer: 2_000_000 },
        );
        const text = content.data?.encoding === 'base64' && content.data.content
          ? Buffer.from(content.data.content.replace(/\s+/g, ''), 'base64').toString('utf8')
          : '';
        files.push({ path: pathName, text: text.slice(0, 100_000), sha: blob.sha, size: blob.size, url: content.data?.html_url ?? blob.url });
      }
      return files;
    },
  });

  const indexConnectorMemory = async (connectorId: string): Promise<{ ok: boolean; records: number; evidence: number; operations: number; result?: unknown; error?: string }> => {
    const connector = getConnector(workspaceRoot, connectorId);
    if (!connector) return { ok: false, records: 0, evidence: 0, operations: 0, error: 'Connector not found.' };
    const bundle = exportConnectorDocumentsForMemory(workspaceRoot, { connectorId });
    if (bundle.recordCount === 0) return { ok: true, records: 0, evidence: 0, operations: 0, result: { importedMemories: 0, importedEvidence: 0, importedOperations: 0 } };
    try {
      const res = await mcpClient.callTool('memory_import', { data: bundle.data });
      if (res?.isError) {
        const text = typeof res.content?.[0]?.text === 'string' ? res.content[0].text : 'memory_import failed.';
        return { ok: false, records: bundle.recordCount, evidence: bundle.evidenceCount, operations: bundle.operationCount, error: text };
      }
      const text = typeof res?.content?.[0]?.text === 'string' ? res.content[0].text : '';
      const parsed = text.trim() ? JSON.parse(text) : {};
      return { ok: true, records: bundle.recordCount, evidence: bundle.evidenceCount, operations: bundle.operationCount, result: parsed };
    } catch (err) {
      return { ok: false, records: bundle.recordCount, evidence: bundle.evidenceCount, operations: bundle.operationCount, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const runConnector = async (connectorId: string): Promise<{ ok: boolean; run?: unknown; connector?: unknown | null; documents?: unknown[]; memory?: unknown; errors?: string[]; error?: string }> => {
    const connector = getConnector(workspaceRoot, connectorId);
    if (!connector) return { ok: false, error: 'Connector not found.' };
    const startedAt = new Date().toISOString();
    const running = recordConnectorRun(workspaceRoot, {
      connectorId: connector.id,
      flow: 'checkpoint',
      status: 'running',
      startedAt,
      checkpointBefore: connector.checkpoint,
    });
    try {
      const result = await runConnectorCheckpoint(connector);
      const persisted = upsertConnectorDocuments(workspaceRoot, result.documents);
      const run = finishConnectorRun(workspaceRoot, connector.id, running.id, {
        status: result.failures.length ? 'failed' : 'succeeded',
        documentsSeen: result.documents.length,
        documentsIndexed: persisted.length,
        failures: result.failures.length,
        error: result.failures[0],
        checkpointAfter: result.checkpoint,
      }) ?? running;
      const memory = await indexConnectorMemory(connector.id);
      return {
        ok: result.failures.length === 0,
        run,
        connector: getConnector(workspaceRoot, connector.id) ?? null,
        documents: persisted.slice(0, 20),
        memory,
        errors: result.failures,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const run = finishConnectorRun(workspaceRoot, connector.id, running.id, {
        status: 'failed',
        error: msg,
      }) ?? running;
      return { ok: false, run, connector: getConnector(workspaceRoot, connector.id) ?? null, error: msg, errors: [msg] };
    }
  };

  const connectorRunsInFlight = new Set<string>();
  const connectorPollMinutes = (connector: { config?: Record<string, unknown> }): number => {
    const raw = connector.config?.pollMinutes;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0;
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 0;
  };
  const connectorDueForScheduledRun = (connector: ReturnType<typeof listConnectors>[number], now: number): boolean => {
    if (connector.status !== 'active') return false;
    if (!connector.flows.includes('checkpoint')) return false;
    if (connectorRunsInFlight.has(connector.id)) return false;
    const pollMinutes = connectorPollMinutes(connector);
    if (pollMinutes <= 0) return false;
    const lastRunMs = connector.lastRunAt ? Date.parse(connector.lastRunAt) : 0;
    return !Number.isFinite(lastRunMs) || lastRunMs <= 0 || now - lastRunMs >= pollMinutes * 60_000;
  };
  const tickConnectorScheduler = (): void => {
    const now = Date.now();
    for (const connector of listConnectors(workspaceRoot, { status: 'active' })) {
      if (!connectorDueForScheduledRun(connector, now)) continue;
      connectorRunsInFlight.add(connector.id);
      void runConnector(connector.id)
        .catch(() => undefined)
        .finally(() => connectorRunsInFlight.delete(connector.id));
    }
  };
  const connectorSchedulerTimer = setInterval(tickConnectorScheduler, 60_000);
  connectorSchedulerTimer.unref?.();
  const connectorSchedulerBootTimer = setTimeout(tickConnectorScheduler, 10_000);
  connectorSchedulerBootTimer.unref?.();

  const syncConnectorPermissions = async (connectorId: string): Promise<{ ok: boolean; run?: unknown; connector?: unknown | null; permissions?: unknown[]; errors?: string[]; error?: string }> => {
    const connector = getConnector(workspaceRoot, connectorId);
    if (!connector) return { ok: false, error: 'Connector not found.' };
    if (connector.source !== 'github') return { ok: false, error: `Permission sync is not implemented for ${connector.source}.` };
    const startedAt = new Date().toISOString();
    try {
      const credential = connector.credential.mode === 'static' ? githubStaticToken(connector) : {};
      if (connector.credential.mode === 'static' && !credential.token) throw new Error(credential.error ?? 'Static GitHub connector credential is not available.');
      const client = credential.token ? githubTokenPermissionClient(connector, credential.token) : githubGhPermissionClient();
      const result = await runGithubConnectorPermissionSync(connector, client);
      const persisted = upsertConnectorPermissions(workspaceRoot, result.permissions);
      const run = recordConnectorRun(workspaceRoot, {
        connectorId: connector.id,
        flow: 'permission-sync',
        status: result.failures.length ? 'failed' : 'succeeded',
        startedAt,
        permissionsSeen: result.permissions.length,
        permissionsIndexed: persisted.length,
        failures: result.failures.length,
        error: result.failures[0],
        checkpointBefore: connector.checkpoint,
        checkpointAfter: result.checkpoint,
      });
      return {
        ok: result.failures.length === 0,
        run,
        connector: getConnector(workspaceRoot, connector.id) ?? null,
        permissions: persisted.slice(0, 20),
        errors: result.failures,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const run = recordConnectorRun(workspaceRoot, {
        connectorId: connector.id,
        flow: 'permission-sync',
        status: 'failed',
        startedAt,
        error: msg,
        checkpointBefore: connector.checkpoint,
      });
      return { ok: false, run, connector: getConnector(workspaceRoot, connector.id) ?? null, error: msg, errors: [msg] };
    }
  };

  const createTrackDraftPr = async (idOrKey: string): Promise<{ ok: boolean; url?: string; pr?: TrackPrView | null; branch?: string | null; itemKey?: string; items: unknown[]; error?: string }> => {
    const item = getWorkItem(workspaceRoot, idOrKey);
    if (!item) return { ok: false, items: listWorkItems(workspaceRoot), error: `Unknown work item "${idOrKey}".` };
    const branch = await currentGitBranch();
    if (!branch) return { ok: false, items: listWorkItems(workspaceRoot), itemKey: item.key, error: 'No current Git branch.' };
    const linkedBranch = item.codeLinks.find((link) => link.kind === 'branch')?.ref;
    if (linkedBranch && linkedBranch !== branch) {
      return { ok: false, items: listWorkItems(workspaceRoot), branch, itemKey: item.key, error: `Switch to ${linkedBranch} before creating a PR for ${item.key}.` };
    }
    const dirty = (await git(['status', '--porcelain', '--', '.'], workspaceRoot)).trim();
    if (dirty) return { ok: false, items: listWorkItems(workspaceRoot), branch, itemKey: item.key, error: 'Commit or stash local changes before creating a PR.' };

    const issue = getGithubLinks(workspaceRoot)[item.id];
    const body = [
      `Track item: ${item.key}`,
      item.description?.trim(),
      issue?.number ? `Fixes #${issue.number}` : undefined,
      `Branch: ${branch}`,
    ].filter(Boolean).join('\n\n');
    const created = await ghText(['pr', 'create', '--draft', '--title', `${item.key}: ${item.title}`, '--body', body], { timeout: 20_000, maxBuffer: 500_000 });
    if (!created.ok) return { ok: false, items: listWorkItems(workspaceRoot), branch, itemKey: item.key, error: created.error ?? 'GitHub CLI could not create the PR.' };
    const url = created.stdout.split(/\s+/).find((part) => /^https?:\/\//.test(part)) ?? created.stdout.trim();
    if (url) linkWorkItem(workspaceRoot, item.id, { codeLinks: [{ kind: 'pull-request', ref: url, label: 'GitHub PR' }] });
    setPrCache(null);
    const status = await readTrackPrStatus();
    return { ok: true, url, pr: status.pr, branch, itemKey: item.key, items: listWorkItems(workspaceRoot) };
  };

  const importTrackIssuesFromGh = async (args: Record<string, unknown>): Promise<{ direction: 'import'; dryRun: boolean; imported: Array<{ issueNumber: number; title: string; action: 'create' | 'update'; key?: string }>; errors: string[]; items: unknown[] }> => {
    const project = ensureProject(workspaceRoot);
    const limit = Math.min(Math.max(1, Number(args.limit) || 30), 100);
    const state = args.state === 'all' || args.state === 'closed' ? String(args.state) : 'open';
    const dryRun = args.dryRun === true;
    const ghIssues = await ghJson<Array<GithubIssue & { url?: string }>>(
      ['issue', 'list', '--state', state, '--limit', String(limit), '--json', 'number,title,body,state,url,labels,assignees'],
      { timeout: 12_000, maxBuffer: 4_000_000 },
    );
    if (ghIssues.error) return { direction: 'import', dryRun, imported: [], errors: [ghIssues.error], items: listWorkItems(workspaceRoot) };

    const imported: Array<{ issueNumber: number; title: string; action: 'create' | 'update'; key?: string }> = [];
    const errors: string[] = [];
    const links = getGithubLinks(workspaceRoot);
    const byNumber = new Map<number, string>();
    for (const [wid, link] of Object.entries(links)) byNumber.set(link.number, wid);

    for (const raw of ghIssues.data ?? []) {
      const issue: GithubIssue = {
        ...raw,
        state: String(raw.state ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open',
        html_url: raw.html_url ?? raw.url,
      };
      const mapped = issueToWorkItem(issue, project);
      const existingByKey = mapped.key ? getWorkItem(workspaceRoot, mapped.key) : undefined;
      const existingById = byNumber.get(issue.number);
      const existing = existingByKey ?? (existingById ? getWorkItem(workspaceRoot, existingById) : undefined);
      imported.push({ issueNumber: issue.number, title: issue.title, action: existing ? 'update' : 'create', key: existing?.key ?? mapped.key });
      if (dryRun) continue;
      try {
        if (existing) {
          updateWorkItem(workspaceRoot, existing.id, mapped.patch, 'agent');
          setGithubLink(workspaceRoot, existing.id, { number: issue.number, url: issue.html_url ?? '' });
        } else {
          const created = createWorkItem(workspaceRoot, { ...mapped.input, actor: 'agent' });
          setGithubLink(workspaceRoot, created.id, { number: issue.number, url: issue.html_url ?? '' });
        }
      } catch (error) {
        errors.push(`#${issue.number}: ${(error as Error).message}`);
      }
    }

    return { direction: 'import', dryRun, imported, errors, items: listWorkItems(workspaceRoot) };
  };

  const mergeCurrentTrackPr = async (): Promise<{ ok: boolean; pr?: TrackPrView | null; branch?: string | null; itemKey?: string; items: unknown[]; error?: string }> => {
    const status = await readTrackPrStatus();
    if (!status.pr?.number) return { ok: false, branch: status.branch, itemKey: status.itemKey, items: listWorkItems(workspaceRoot), error: status.error ?? 'No pull request for the current branch.' };
    if (status.pr.isDraft) return { ok: false, pr: status.pr, branch: status.branch, itemKey: status.itemKey, items: listWorkItems(workspaceRoot), error: 'Mark the pull request ready before merging.' };
    const merged = await ghText(['pr', 'merge', String(status.pr.number), '--squash', '--delete-branch'], { timeout: 20_000, maxBuffer: 500_000 });
    if (!merged.ok) return { ok: false, pr: status.pr, branch: status.branch, itemKey: status.itemKey, items: listWorkItems(workspaceRoot), error: merged.error ?? 'GitHub CLI could not merge the PR.' };
    if (status.itemKey) {
      const project = getProject(workspaceRoot) ?? ensureProject(workspaceRoot);
      const done = project.workflowStates.find((state) => state.category === 'completed');
      if (done) transitionWorkItem(workspaceRoot, status.itemKey, done.id, 'user');
    }
    setPrCache(null);
    return { ok: true, pr: status.pr, branch: status.branch, itemKey: status.itemKey, items: listWorkItems(workspaceRoot) };
  };

  const submitTrackPrReview = async (args: Record<string, unknown>): Promise<{ ok: boolean; pr?: TrackPrView | null; branch?: string | null; itemKey?: string; error?: string }> => {
    const status = await readTrackPrStatus();
    if (!status.pr?.number) return { ok: false, branch: status.branch, itemKey: status.itemKey, error: status.error ?? 'No pull request for the current branch.' };
    const decision = args.decision === 'approve' || args.decision === 'request-changes' ? args.decision : 'comment';
    const body = String(args.body ?? '').trim();
    if (decision === 'comment' && !body) return { ok: false, pr: status.pr, branch: status.branch, itemKey: status.itemKey, error: 'Review comment cannot be empty.' };
    const flag = decision === 'approve' ? '--approve' : decision === 'request-changes' ? '--request-changes' : '--comment';
    const cmd = ['pr', 'review', String(status.pr.number), flag];
    if (body) cmd.push('--body', body);
    const reviewed = await ghText(cmd, { timeout: 15_000, maxBuffer: 500_000 });
    if (!reviewed.ok) return { ok: false, pr: status.pr, branch: status.branch, itemKey: status.itemKey, error: reviewed.error ?? 'GitHub CLI could not submit the review.' };
    return { ok: true, pr: status.pr, branch: status.branch, itemKey: status.itemKey };
  };

  const fixCurrentTrackPrChecks = async (): Promise<{ ok: boolean; task?: BackgroundTaskRecord; pr?: TrackPrView | null; branch?: string | null; itemKey?: string; error?: string }> => {
    const status = await readTrackPrStatus();
    if (!status.pr?.number) return { ok: false, branch: status.branch, itemKey: status.itemKey, error: status.error ?? 'No pull request for the current branch.' };

    const sessionKey = getActiveAgent().sessionKey;
    const task = createBackgroundTask(workspaceRoot, {
      kind: 'verification',
      title: `Fix failing checks — PR #${status.pr.number}`,
      sessionKey,
      status: 'running',
    });
    const fixerKey = `fix-ci:${task.id}`;
    const created = updateBackgroundTask(workspaceRoot, task.id, { transcript: { kind: 'task', id: task.id, parentSessionKey: fixerKey } }) ?? task;
    emitTaskEvent('created', created);

    void (async () => {
      try {
        taskProgress(task.id, 'reading-ci', `PR #${status.pr?.number ?? ''}`);
        const checks = await ghJson<Array<{ name?: string; state?: string; bucket?: string; workflow?: string; link?: string }>>(
          ['pr', 'checks', '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'],
          { timeout: 10_000, maxBuffer: 2_000_000, allowNonZeroJson: true },
        );
        const runs = await ghJson<Array<{ databaseId?: number; name?: string; displayTitle?: string; status?: string; conclusion?: string; workflowName?: string; headBranch?: string; event?: string; createdAt?: string; url?: string }>>(
          ['run', 'list', '--limit', '10', '--json', 'databaseId,name,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url'],
          { timeout: 10_000, maxBuffer: 4_000_000 },
        );
        const failedChecks = (checks.data ?? []).filter((c) => {
          const bucket = String(c.bucket ?? c.state ?? '').toLowerCase();
          return bucket === 'fail' || bucket === 'failed' || bucket === 'failure' || bucket === 'cancel' || bucket === 'cancelled';
        });
        const failedRun = (runs.data ?? []).find((r) => String(r.conclusion ?? '').toLowerCase() === 'failure');
        let failedLog = '';
        if (failedRun?.databaseId) {
          const log = await ghText(['run', 'view', String(failedRun.databaseId), '--log-failed'], { timeout: 20_000, maxBuffer: 8_000_000 });
          failedLog = (log.stdout || log.error || '').slice(-40_000);
        }
        const prompt = [
          'The current branch has a GitHub pull request with failing CI. Fix the failing checks locally.',
          'Do not commit, push, merge, or create a pull request. Make the smallest code changes needed, then stop.',
          `PR: #${status.pr?.number} ${status.pr?.title ?? ''}`,
          `Branch: ${status.branch ?? status.pr?.headRefName ?? 'current branch'}`,
          failedChecks.length ? `Failing checks:\n${failedChecks.map((c) => `- ${c.workflow ? `${c.workflow}: ` : ''}${c.name ?? 'check'} (${c.bucket ?? c.state ?? 'failed'})${c.link ? ` ${c.link}` : ''}`).join('\n')}` : 'Failing checks: not available from gh pr checks.',
          failedRun ? `Latest failed run: ${failedRun.workflowName ?? failedRun.name ?? 'run'} ${failedRun.databaseId ?? ''} ${failedRun.url ?? ''}` : 'Latest failed run: not available from gh run list.',
          failedLog ? `Failed log excerpt:\n${failedLog}` : '',
        ].filter(Boolean).join('\n\n');
        taskProgress(task.id, 'fixing-ci', failedChecks[0]?.name ?? failedRun?.workflowName ?? 'failed checks');
        const fixer = spawnTaskAgent(fixerKey, 'write');
        const noop = (): void => {};
        const cb = {
          onStatusUpdate: (text: string) => { if (text) taskProgress(task.id, 'working', text.slice(0, 80)); },
          onToolStart: noop, onToolEnd: noop, onAssistantDelta: noop, onAssistantTurnStart: noop,
          onAssistantTurnEnd: noop, onReasoningDelta: noop, onUsageUpdate: noop, onPlanUpdate: noop,
        } as never;
        await (fixer as { runTurn: (p: string, cb: unknown) => Promise<unknown> }).runTurn(prompt, cb);
        const changed = (await git(['status', '--short', '--', '.'], workspaceRoot)).split('\n').filter(Boolean);
        const done = updateBackgroundTask(workspaceRoot, task.id, { status: 'completed', result: { pr: status.pr?.number, changedFiles: changed.length } });
        if (done) emitTaskEvent('completed', done);
      } catch (err) {
        const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: `Fix CI task failed: ${err instanceof Error ? err.message : err}` });
        if (failed) emitTaskEvent('failed', failed);
      }
    })();

    return { ok: true, task: created, pr: status.pr, branch: status.branch, itemKey: status.itemKey };
  };
  return {
    ghText, ghJson, githubApiBase, githubStaticToken, githubConnectorToken, connectorEnvToken,
    mcpConnectorClient, githubTokenJson, currentGitBranch, trackItemForBranch, readTrackPrStatus,
    githubGhValidationClient, githubTokenValidationClient, githubGhPermissionClient, githubTokenPermissionClient,
    validateGithubConnector, githubConnectorClient,
    indexConnectorMemory, runConnector, syncConnectorPermissions,
    createTrackDraftPr, importTrackIssuesFromGh, mergeCurrentTrackPr, submitTrackPrReview, fixCurrentTrackPrChecks,
    connectorSchedulerTimer, connectorSchedulerBootTimer,
    resetGhEnvCache: (): void => { ghEnvCache = null; },
  };
}
