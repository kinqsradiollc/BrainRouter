/**
 * Shared connector-checkpoint runner (Connectors — agent parity).
 *
 * Before this, the ONLY place the 12 connector runtimes were orchestrated was
 * the desktop Electron host (`brainrouter-desktop/electron/host.ts`), so only
 * the desktop UI could run a connector checkpoint (ingest → memory). This module
 * lifts the per-source switch and the full checkpoint orchestration into core so
 * BOTH the host AND the chat/CLI/MCP agent drive one code path.
 *
 * The host and the agent differ only in what they can supply that core can't
 * build alone:
 *   - `githubClient` — the host passes a keychain/gh-CLI-aware client; the agent
 *     passes a static/dynamic-token REST client (no keychain).
 *   - `mcpClient`    — the `mcp` source reads MCP resources through the caller's
 *     own connected MCP surface.
 *   - `envToken`     — resolves a STATIC credential from the env var named by
 *     `connector.credential.ref`. The default calls the runtime host; callers
 *     overrides it so `config:track` refs resolve too.
 *
 * Web / filesystem / gitlab / slack / jira / confluence / notion / linear /
 * google-drive / gmail are all constructed here from the existing factory
 * functions — no per-source knowledge leaks back to the caller.
 *
 * Path normalization is deterministic; process environment and cwd access stay
 * behind the runtime host.
 */
import path from 'node:path';
import type {
  ConnectorCheckpoint,
  ConnectorDocument,
  ConnectorDocumentRecord,
  ConnectorRecord,
  ConnectorRunRecord,
} from '@kinqs/brainrouter-types';
import {
  confluenceTokenClient,
  fetchWebClient,
  gitlabTokenClient,
  gmailTokenClient,
  googleDriveTokenClient,
  jiraTokenClient,
  linearTokenClient,
  nodeFsClient,
  notionTokenClient,
  slackTokenClient,
  runConfluenceConnectorCheckpoint,
  runFilesystemConnectorCheckpoint,
  runGithubConnectorCheckpoint,
  runGitlabConnectorCheckpoint,
  runGmailConnectorCheckpoint,
  runGoogleDriveConnectorCheckpoint,
  runJiraConnectorCheckpoint,
  runLinearConnectorCheckpoint,
  runMcpConnectorCheckpoint,
  runNotionConnectorCheckpoint,
  runSlackConnectorCheckpoint,
  runWebConnectorCheckpoint,
  type GithubConnectorClient,
  type McpConnectorClient,
} from '../index.js';
import { finishConnectorRun, getConnector, recordConnectorRun } from '../store/connectorStore.js';
import { upsertConnectorDocuments } from '../store/documentStore.js';
import type { ConnectorRuntimeHost } from './host/contracts.js';
import { nodeConnectorRuntimeHost } from './host/nodeConnectorRuntimeHost.js';

/** The shared checkpoint result shape every `run<Source>ConnectorCheckpoint` returns. */
export interface CheckpointResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

/** Credential resolution for a STATIC env-token connector (never returns the value on error). */
export type EnvTokenResolver = (
  connector: ConnectorRecord,
  label: string,
) => { token?: string; error?: string };

export interface CheckpointRunnerDeps {
  /** Process context. Defaults to the local Node host. */
  runtimeHost?: ConnectorRuntimeHost;
  /**
   * GitHub connector client. The host passes its keychain/gh-CLI-aware client;
   * the agent passes a static/dynamic-token REST client. When absent, a github
   * connector in `oauth`/`keychain` mode throws the desktop-only guidance error.
   */
  githubClient?: (connector: ConnectorRecord) => GithubConnectorClient | undefined;
  /** MCP client for the `mcp` source. Absent → the mcp source is unavailable to this caller. */
  mcpClient?: (connector: ConnectorRecord) => McpConnectorClient | undefined;
  /**
   * STATIC env-token resolver. Defaults to the runtime host's environment.
   * Never mutate; only reads the env var named by the connector's credential ref.
   */
  envToken?: EnvTokenResolver;
  /**
   * Server-side OAuth token resolver.  The backend passes a token it opened from
   * its sealed connector record; desktop and CLI intentionally leave this unset
   * and retain their existing credential resolution behaviour.  Keeping the
   * value behind a callback prevents it from being retained in a connector file.
   */
  oauthToken?: (connector: ConnectorRecord, label: string) => { token?: string; error?: string };
  /** Root the workspace lives at — used to resolve relative filesystem-connector roots. */
  workspaceRoot?: string;
}

const OAUTH_KEYCHAIN_GUIDANCE =
  'This connector uses OAuth/keychain credentials — run it from BrainRouter Desktop.';

/** Default STATIC env-token resolver: reads through the selected runtime host. */
export function defaultEnvTokenResolver(
  connector: ConnectorRecord,
  label: string,
  runtimeHost: ConnectorRuntimeHost = nodeConnectorRuntimeHost,
): { token?: string; error?: string } {
  const credential = connector.credential;
  if (!credential || credential.mode === 'none') return {};
  if (credential.mode !== 'static') {
    return { error: `${label} connector currently supports static environment-token credentials only.` };
  }
  const ref = credential.ref?.trim();
  if (!ref) return { error: `${label} connector credential reference is required.` };
  const token = runtimeHost.environmentValue(ref)?.trim();
  if (!token) return { error: `${label} connector credential ${ref} is not available in the environment.` };
  return { token };
}

function connectorConfigString(connector: ConnectorRecord, key: string): string {
  const value = connector.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function requireConnectorConfig(connector: ConnectorRecord, key: string, label: string): string {
  const value = connectorConfigString(connector, key);
  if (!value) throw new Error(`${label} connector config ${key} is required.`);
  return value;
}

/** Resolve a filesystem connector's roots against the workspace root (absolute paths in place). */
function filesystemConnectorForRunner(
  connector: ConnectorRecord,
  workspaceRoot: string | undefined,
  runtimeHost: ConnectorRuntimeHost,
): ConnectorRecord {
  const rawRoots = Array.isArray(connector.config.roots)
    ? connector.config.roots.filter((root): root is string => typeof root === 'string')
    : [];
  const base = workspaceRoot ?? runtimeHost.currentWorkingDirectory();
  return {
    ...connector,
    config: {
      ...connector.config,
      roots: rawRoots
        .map((root) => {
          const trimmed = root.trim();
          if (!trimmed) return trimmed;
          return path.isAbsolute(trimmed) ? trimmed : path.resolve(base, trimmed);
        })
        .filter(Boolean),
    },
  };
}

/**
 * Build a per-source checkpoint runner from the caller's deps. Returns a single
 * function `(connector) => Promise<CheckpointResult>` implementing the switch so
 * the host and the agent share ONE altitude (not two divergent switches).
 */
export function buildCheckpointRunner(
  deps: CheckpointRunnerDeps = {},
): (connector: ConnectorRecord) => Promise<CheckpointResult> {
  const runtimeHost = deps.runtimeHost ?? nodeConnectorRuntimeHost;
  const envToken: EnvTokenResolver = deps.envToken
    ?? ((connector, label) => defaultEnvTokenResolver(connector, label, runtimeHost));
  const requireStaticToken = (connector: ConnectorRecord, label: string): { token: string; oauth: boolean } => {
    const oauth = deps.oauthToken?.(connector, label);
    if (oauth?.token) return { token: oauth.token, oauth: true };
    if (oauth?.error) throw new Error(oauth.error);
    const cred = envToken(connector, label);
    if (!cred.token) throw new Error(cred.error ?? `${label} connector requires a static token credential.`);
    return { token: cred.token, oauth: false };
  };

  return async (connector: ConnectorRecord): Promise<CheckpointResult> => {
    switch (connector.source) {
      case 'github': {
        const client = deps.githubClient?.(connector);
        if (!client) {
          // No caller-provided client → only static env-token GitHub can run
          // here; oauth/keychain modes are desktop-only.
          throw new Error(OAUTH_KEYCHAIN_GUIDANCE);
        }
        return await runGithubConnectorCheckpoint(connector, client);
      }
      case 'filesystem':
        return await runFilesystemConnectorCheckpoint(
          filesystemConnectorForRunner(connector, deps.workspaceRoot, runtimeHost),
          nodeFsClient(),
        );
      case 'web': {
        const cred = envToken(connector, 'Web');
        if (cred.error) throw new Error(cred.error);
        return await runWebConnectorCheckpoint(connector, fetchWebClient({ headerToken: cred.token }));
      }
      case 'gitlab': {
        const credential = requireStaticToken(connector, 'GitLab');
        const hostUrl = typeof connector.config.hostUrl === 'string' ? connector.config.hostUrl : undefined;
        return await runGitlabConnectorCheckpoint(connector, gitlabTokenClient(credential.token, hostUrl, { authMode: credential.oauth ? 'bearer' : 'private-token' }));
      }
      case 'slack':
        return await runSlackConnectorCheckpoint(connector, slackTokenClient(requireStaticToken(connector, 'Slack').token));
      case 'jira':
        return await runJiraConnectorCheckpoint(
          connector,
          jiraTokenClient(requireStaticToken(connector, 'Jira').token, requireConnectorConfig(connector, 'baseUrl', 'Jira')),
        );
      case 'confluence':
        return await runConfluenceConnectorCheckpoint(
          connector,
          confluenceTokenClient(
            requireStaticToken(connector, 'Confluence').token,
            requireConnectorConfig(connector, 'baseUrl', 'Confluence'),
          ),
        );
      case 'notion':
        return await runNotionConnectorCheckpoint(connector, notionTokenClient(requireStaticToken(connector, 'Notion').token));
      case 'linear': {
        const credential = requireStaticToken(connector, 'Linear');
        return await runLinearConnectorCheckpoint(connector, linearTokenClient(credential.token, { oauth: credential.oauth }));
      }
      case 'mcp': {
        const client = deps.mcpClient?.(connector);
        if (!client) {
          throw new Error('MCP connector requires a connected MCP client — none is available in this context.');
        }
        return await runMcpConnectorCheckpoint(connector, client);
      }
      case 'google-drive':
        return await runGoogleDriveConnectorCheckpoint(
          connector,
          googleDriveTokenClient(requireStaticToken(connector, 'Google Drive').token),
        );
      case 'gmail':
        return await runGmailConnectorCheckpoint(connector, gmailTokenClient(requireStaticToken(connector, 'Gmail').token));
      default:
        throw new Error(`Connector runtime is not implemented for ${connector.source}.`);
    }
  };
}

export interface RunConnectorCheckpointResult {
  ok: boolean;
  run: ConnectorRunRecord;
  documents: ConnectorDocumentRecord[];
  failures: string[];
  error?: string;
}

/**
 * Full checkpoint orchestration MINUS the memory import — mirrors the host's
 * `runConnector` up to (and not including) `indexConnectorMemory`:
 *   getConnector → recordConnectorRun → run the checkpoint →
 *   upsertConnectorDocuments → finishConnectorRun.
 *
 * The caller (host or agent) owns the memory-import step because each has its
 * own memory client. On success `documents` are the PERSISTED document records
 * (deduped/upserted), so the caller can immediately export them for memory.
 */
export async function runConnectorCheckpointCore(
  workspaceRoot: string,
  connectorId: string,
  deps: CheckpointRunnerDeps = {},
): Promise<RunConnectorCheckpointResult> {
  const connector = getConnector(workspaceRoot, connectorId);
  if (!connector) {
    throw new Error(`Connector not found: ${connectorId}`);
  }
  const runCheckpoint = buildCheckpointRunner({ ...deps, workspaceRoot });
  const startedAt = new Date().toISOString();
  const running = recordConnectorRun(workspaceRoot, {
    connectorId: connector.id,
    flow: 'checkpoint',
    status: 'running',
    startedAt,
    checkpointBefore: connector.checkpoint,
  });
  try {
    const result = await runCheckpoint(connector);
    const persisted = upsertConnectorDocuments(workspaceRoot, result.documents);
    const run =
      finishConnectorRun(workspaceRoot, connector.id, running.id, {
        status: result.failures.length ? 'failed' : 'succeeded',
        documentsSeen: result.documents.length,
        documentsIndexed: persisted.length,
        failures: result.failures.length,
        error: result.failures[0],
        checkpointAfter: result.checkpoint,
      }) ?? running;
    return {
      ok: result.failures.length === 0,
      run,
      documents: persisted,
      failures: result.failures,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const run =
      finishConnectorRun(workspaceRoot, connector.id, running.id, {
        status: 'failed',
        error: message,
      }) ?? running;
    return { ok: false, run, documents: [], failures: [message], error: message };
  }
}
