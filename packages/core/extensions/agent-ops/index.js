/**
 * Built-in extension: agent-ops — three operational tools the agent lacked, each
 * wired to the SAME in-process/on-disk system its human-facing counterpart uses:
 *
 *   • schedule_task — create / list / cancel a scheduled agent task. Backed by the
 *     core `schedule` store (schedules.json), the exact store the `/schedule`
 *     slash command and the CLI's schedule ticker read + fire. A task the agent
 *     creates here is a first-class schedule the ticker dispatches — no shadow
 *     scheduler.
 *   • notify_user — surface an out-of-band message to the user. Backed by the
 *     `completionInbox` singleton: the same queue detached workers/agents use to
 *     "report back" between turns. The host drains it into the next turn and the
 *     CLI/Desktop print it as an above-prompt notice, so this is a real push
 *     channel, not a log line.
 *   • session_info — read-only view of the current session (title + recent
 *     transcript activity), the workspace's recent sessions, and live child
 *     agents. Backed by the session meta/transcript stores and the orchestration
 *     child-session store.
 *
 * Plain ESM (no build step). It deep-imports the built core modules under
 * `../../dist/*`; if the package isn't built, activation fails soft (the loader
 * is fault-isolated) and the agent simply has no agent-ops tools.
 *
 * The current session key is read from `BRAINROUTER_RUNTIME_SESSION_KEY` — the
 * env the runtime backends set on a spawned session — so schedules are OWNED by
 * (and fire for) the session that created them, and notifications route to it.
 */

const SESSION_KEY_ENV = 'BRAINROUTER_RUNTIME_SESSION_KEY';

const objSchema = (properties, required) => ({
  type: 'object',
  properties: properties || {},
  required: required || [],
  additionalProperties: false,
});

/** Parse a compact duration like "30s", "5m", "2h", "1d" into milliseconds. */
function parseDurationMs(raw) {
  const m = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/.exec(String(raw || ''));
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

/** Resolve the "at" target: an ISO timestamp, or HH:MM meaning the next such wall-clock time. */
function resolveAt(raw, now) {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (hm) {
    const h = Number(hm[1]);
    const min = Number(hm[2]);
    if (h > 23 || min > 59) return undefined;
    const target = new Date(now);
    target.setHours(h, min, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target;
  }
  const t = Date.parse(String(raw || ''));
  if (Number.isFinite(t) && t > now.getTime()) return new Date(t);
  return undefined;
}

function shortPreview(content, max = 160) {
  let s;
  if (content == null) s = '';
  else if (typeof content === 'string') s = content;
  else s = JSON.stringify(content);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export async function activate(host) {
  let schedule;
  let inbox;
  let meta;
  let transcript;
  let orchestration;
  try {
    schedule = await import('../../dist/schedule/index.js');
    inbox = await import('../../dist/session/completion/completionInbox.js');
    meta = await import('../../dist/session/state/sessionMetaStore.js');
    transcript = await import('../../dist/session/transcript/sessionStore.js');
    orchestration = await import('../../dist/orchestration/session/orchestrator.js');
  } catch (err) {
    host.log('core not built — agent-ops tools unavailable', { error: String((err && err.message) || err) });
    return;
  }

  const { addSchedule, loadSchedules, removeSchedule, setScheduleEnabled, parseCron, nextCronFire } = schedule;
  const { enqueueCompletion, pendingCompletionCount } = inbox;
  const { getSessionMeta } = meta;
  const { readTranscriptEntries, listTranscripts, transcriptExists } = transcript;
  const { listSessions, formatSessionSummary } = orchestration;

  const ws = host.workspaceRoot;
  const currentSessionKey = () => process.env[SESSION_KEY_ENV]?.trim() || '';

  // ---------------------------------------------------------------------------
  // schedule_task — real schedule store (schedules.json / the /schedule ticker)
  // ---------------------------------------------------------------------------
  host.registerTool({
    name: 'schedule_task',
    description:
      'Create, list, or cancel a scheduled agent task. Scheduled tasks dispatch a slash command (must start with "/") on a recurring cron or one-shot delay, fired by BrainRouter\'s schedule ticker — the same store the /schedule command uses. ' +
      'action="create" needs `command` plus exactly ONE of `cron` (5-field "min hour dom month dow"), `in` ("30s"|"5m"|"2h"|"1d"), or `at` ("HH:MM" for the next such time, or an ISO timestamp). ' +
      'action="list" returns this session\'s tasks; action="cancel" removes one by `id`.',
    inputSchema: objSchema(
      {
        action: { type: 'string', enum: ['create', 'list', 'cancel'], description: 'What to do.' },
        command: { type: 'string', description: 'Slash command to run when the task fires, e.g. "/ci-status". Required for create.' },
        cron: { type: 'string', description: 'Recurring 5-field cron expression, e.g. "*/15 * * * *".' },
        in: { type: 'string', description: 'One-shot delay from now, e.g. "5m", "2h", "1d".' },
        at: { type: 'string', description: 'One-shot time: "HH:MM" (next occurrence) or an ISO timestamp.' },
        id: { type: 'string', description: 'Task id to cancel (from action="list"). Required for cancel.' },
      },
      ['action'],
    ),
    accessTier: 'write',
    actionKind: 'bg',
    parallelSafe: false,
    handle: async (args) => {
      const action = String(args.action || '');
      const owner = currentSessionKey();

      if (action === 'list') {
        const mine = loadSchedules(ws).filter((s) => !owner || s.owner === owner);
        return JSON.stringify({
          ok: true,
          owner: owner || null,
          count: mine.length,
          tasks: mine.map((s) => ({
            id: s.id,
            kind: s.kind,
            expr: s.expr,
            command: s.command,
            enabled: s.enabled,
            nextRun: s.nextRun,
            lastRun: s.lastRun ?? null,
          })),
        });
      }

      if (action === 'cancel') {
        const id = String(args.id || '').trim();
        if (!id) return JSON.stringify({ ok: false, error: 'cancel requires `id` (see action="list").' });
        const removed = removeSchedule(ws, id);
        return JSON.stringify({ ok: removed, id, removed, error: removed ? undefined : `no task with id ${id}` });
      }

      if (action === 'create') {
        const command = String(args.command || '').trim();
        if (!command.startsWith('/')) {
          return JSON.stringify({ ok: false, error: 'A scheduled task must dispatch a slash command (`command` starting with "/").' });
        }
        const modes = ['cron', 'in', 'at'].filter((k) => args[k] != null && String(args[k]).trim() !== '');
        if (modes.length !== 1) {
          return JSON.stringify({ ok: false, error: 'create needs exactly one of `cron`, `in`, or `at`.' });
        }
        const now = new Date();
        let kind;
        let expr;
        let nextRun;
        if (modes[0] === 'cron') {
          expr = String(args.cron).trim();
          const parsed = parseCron(expr);
          if (!parsed) return JSON.stringify({ ok: false, error: `invalid cron expression: "${expr}" (expected 5 fields: min hour dom month dow)` });
          kind = 'cron';
          nextRun = nextCronFire(parsed, now);
        } else if (modes[0] === 'in') {
          const ms = parseDurationMs(args.in);
          if (!ms) return JSON.stringify({ ok: false, error: `invalid duration: "${args.in}" (use e.g. "30s", "5m", "2h", "1d")` });
          kind = 'once';
          nextRun = new Date(now.getTime() + ms);
          expr = nextRun.toISOString();
        } else {
          const target = resolveAt(args.at, now);
          if (!target) return JSON.stringify({ ok: false, error: `invalid time: "${args.at}" (use "HH:MM" or a future ISO timestamp)` });
          kind = 'once';
          nextRun = target;
          expr = target.toISOString();
        }
        if (!owner) {
          host.log('schedule_task: no runtime session key — task will persist but the ticker filters by owner and cannot fire an unowned task');
        }
        const rec = addSchedule(ws, { kind, expr, command, owner, nextRun: nextRun.toISOString() });
        return JSON.stringify({
          ok: true,
          id: rec.id,
          kind: rec.kind,
          expr: rec.expr,
          command: rec.command,
          nextRun: rec.nextRun,
          owner: owner || null,
          note: owner ? undefined : 'No runtime session key present; this task is persisted but will not fire until a session with a matching owner runs the ticker.',
        });
      }

      return JSON.stringify({ ok: false, error: `unknown action: ${action} (use create | list | cancel)` });
    },
  });

  // ---------------------------------------------------------------------------
  // notify_user — real completion inbox (out-of-band "report back" channel)
  // ---------------------------------------------------------------------------
  host.registerTool({
    name: 'notify_user',
    description:
      'Send an out-of-band notification to the user, surfaced above the prompt and folded into the next turn (BrainRouter\'s completion-feedback channel). ' +
      'Use for status you want the user to see without blocking the conversation — a long task finished, a heads-up, a reminder. NOT for your normal reply text. Provide a short `message`; optional `title` and `level`.',
    inputSchema: objSchema(
      {
        message: { type: 'string', description: 'The notification body (kept short — surfaced as a one-liner + preview).' },
        title: { type: 'string', description: 'Optional short label shown with the notice.' },
        level: { type: 'string', enum: ['info', 'success', 'warn', 'error'], description: 'Severity glyph. Default "info".' },
      },
      ['message'],
    ),
    accessTier: 'write',
    actionKind: 'bg',
    parallelSafe: false,
    handle: async (args) => {
      const message = String(args.message || '').trim();
      if (!message) return JSON.stringify({ ok: false, error: 'notify_user requires a non-empty `message`.' });
      const target = currentSessionKey();
      if (!target) {
        return JSON.stringify({ ok: false, error: `no runtime session key (${SESSION_KEY_ENV}) — cannot route a notification to the user from this context.` });
      }
      const level = String(args.level || 'info');
      const status = level === 'error' ? 'failed' : level === 'warn' ? 'interrupted' : 'completed';
      const id = 'notify_' + Math.random().toString(36).slice(2, 8);
      enqueueCompletion(target, {
        kind: 'workflow',
        id,
        status,
        label: args.title ? String(args.title) : 'notification',
        summary: message,
        completedAt: new Date().toISOString(),
      });
      return JSON.stringify({
        ok: true,
        id,
        level,
        delivered: true,
        session: target,
        pending: pendingCompletionCount(target),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // session_info — read-only current-session + workspace context
  // ---------------------------------------------------------------------------
  host.registerTool({
    name: 'session_info',
    description:
      'Read-only context about the current session and workspace: the current session id/title, its recent transcript activity, the workspace\'s recent sessions, and any live child agents. Use to orient yourself — what session am I in, what just happened, what else is running.',
    inputSchema: objSchema(
      {
        limit: { type: 'number', description: 'How many recent transcript entries of the current session to include (default 8, max 40).' },
        include_sessions: { type: 'boolean', description: 'Include the workspace\'s recent sessions + live child agents. Default true.' },
      },
      [],
    ),
    accessTier: 'read',
    actionKind: 'read_only',
    parallelSafe: true,
    handle: async (args) => {
      const key = currentSessionKey();
      const limit = Math.max(1, Math.min(40, Number(args.limit) || 8));
      const includeSessions = args.include_sessions !== false;

      const out = {
        workspaceRoot: ws,
        currentSessionKey: key || null,
        title: null,
        recentActivity: [],
      };

      if (key) {
        const m = getSessionMeta(ws, key);
        out.title = m.title ?? null;
        if (transcriptExists(ws, key)) {
          out.recentActivity = readTranscriptEntries(ws, key, limit).map((e) => ({
            role: e.role,
            at: e.timestamp,
            preview: shortPreview(e.content),
            ...(e.name ? { tool: e.name } : {}),
          }));
        }
      }

      if (includeSessions) {
        out.recentSessions = listTranscripts(ws, { limit: 5 }).map((s) => ({
          sessionKey: s.sessionKey,
          title: getSessionMeta(ws, s.sessionKey).title ?? s.firstUserMessage ?? null,
          turnCount: s.turnCount,
          modifiedAt: s.modifiedAt,
        }));
        out.childAgents = listSessions(ws)
          .slice(-8)
          .map((s) => ({ id: s.id, role: s.role, status: s.status, updatedAt: s.updatedAt, summary: formatSessionSummary(s) }));
      }

      return JSON.stringify(out);
    },
  });

  host.log('agent-ops: registered schedule_task, notify_user, session_info');
}
