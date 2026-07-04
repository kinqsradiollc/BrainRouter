/**
 * MC-DESK — in-host trigger-ingress lifecycle: Start/Stop the inbound webhook
 * listener from Settings → Automations, no terminal needed. Mirrors the CLI's
 * `serve --triggers` wiring exactly (same core APIs, same default-deny gates:
 * cli.triggers.enabled must be true, loopback bind unless configured, signed
 * deliveries only, allowlisted repos only). One listener per host process;
 * the handle lives here so stop() can close it and status() can report it.
 *
 * Host-side only — this module touches node:http (via core) and config.
 */
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import {
  startTriggerServer,
  listTriggerProviders,
  resolveGithubTriggerSecret,
  resolveSlackTriggerSecret,
  resolveGitlabTriggerSecret,
  resolveJiraTriggerSecret,
  createGithubTriggerSink,
  createSlackTriggerSink,
  createExternalTriggerSink,
  type TriggerServerHandle,
} from '@kinqs/brainrouter-core/triggers';

export interface TriggerServeStatus {
  running: boolean;
  host: string | null;
  port: number | null;
  startedAt: string | null;
  providers: string[];
  /** Rolling tail of resolver outcomes so the panel shows life, not a void. */
  recentEvents: string[];
  lastError: string | null;
}

interface ServeState {
  handle: TriggerServerHandle | null;
  startedAt: string | null;
  recent: string[];
  lastError: string | null;
}

const state: ServeState = { handle: null, startedAt: null, recent: [], lastError: null };
const RECENT_CAP = 20;

function note(line: string): void {
  state.recent.unshift(`${new Date().toISOString()} ${line}`);
  if (state.recent.length > RECENT_CAP) state.recent.length = RECENT_CAP;
}

export function triggerServeStatus(): TriggerServeStatus {
  return {
    running: !!state.handle,
    host: state.handle?.host ?? null,
    port: state.handle?.port ?? null,
    startedAt: state.startedAt,
    providers: state.handle ? listTriggerProviders() : [],
    recentEvents: [...state.recent],
    lastError: state.lastError,
  };
}

export async function startTriggerServe(workspaceRoot: string): Promise<{ ok: boolean; error?: string; host?: string; port?: number }> {
  if (state.handle) return { ok: true, host: state.handle.host, port: state.handle.port };
  const knobs = getCliKnobs().triggers;
  if (knobs.enabled !== true) {
    // Same gate as the CLI: the master switch is the user's explicit opt-in.
    return { ok: false, error: 'Trigger ingress is disabled — turn on "Enable trigger ingress" first (cli.triggers.enabled).' };
  }
  const secrets = {
    github: resolveGithubTriggerSecret({ configSecret: knobs.githubSecret, workspaceRoot }),
    slack: resolveSlackTriggerSecret({ configSecret: knobs.slackSigningSecret, workspaceRoot }),
    gitlab: resolveGitlabTriggerSecret({ configSecret: knobs.gitlabSecret, workspaceRoot }),
    jira: resolveJiraTriggerSecret({ configSecret: knobs.jiraSecret, workspaceRoot }),
  };
  const githubSink = createGithubTriggerSink({
    workspaceRoot,
    mentionHandle: knobs.mentionHandle,
    ciNudge: knobs.ciNudge,
    onResolved: (event, result) => {
      if (result.action === 'enqueued' && result.job) note(`fleet job ${result.job.id} ← ${event.repo}${event.number ? `#${event.number}` : ''}`);
    },
    onNudged: (event, result) => {
      if (result.action === 'nudged') note(`CI-failure nudge posted ← ${event.repo}${event.number ? `#${event.number}` : ''}`);
    },
  });
  const slackSink = createSlackTriggerSink({
    workspaceRoot,
    mentionHandle: knobs.mentionHandle,
    onResolved: (event, result) => {
      if (result.action === 'enqueued' && result.job) note(`fleet job ${result.job.id} ← slack:${event.repo}`);
    },
  });
  const externalSink = createExternalTriggerSink({
    workspaceRoot,
    mentionHandle: knobs.mentionHandle,
    onResolved: (event, result) => {
      if (result.action === 'enqueued' && result.job) note(`fleet job ${result.job.id} ← ${event.provider}:${event.repo}${event.number ? `#${event.number}` : ''}`);
    },
  });

  try {
    state.handle = await startTriggerServer({
      enabled: true, // gated above via cli.triggers.enabled
      host: knobs.host,
      port: knobs.port,
      allowedRepos: knobs.allowedRepos,
      workspaceRoot,
      secrets,
      onEvent: async (event) => {
        await githubSink(event);
        await slackSink(event);
        await externalSink(event);
      },
    });
    state.startedAt = new Date().toISOString();
    state.lastError = null;
    note(`listening on http://${state.handle.host}:${state.handle.port}`);
    return { ok: true, host: state.handle.host, port: state.handle.port };
  } catch (err) {
    state.handle = null;
    state.startedAt = null;
    state.lastError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: state.lastError };
  }
}

export async function stopTriggerServe(): Promise<{ ok: boolean; error?: string }> {
  const handle = state.handle;
  if (!handle) return { ok: true };
  state.handle = null;
  state.startedAt = null;
  try {
    await handle.close();
    note('stopped');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    return { ok: false, error: msg };
  }
}
