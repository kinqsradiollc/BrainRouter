/**
 * PR-OBS-1 — built-in pull-request observer extension.
 *
 * The tool returns immediately after resolving the target PR, then polls with
 * bounded `gh pr view` calls. It never runs overlapping polls and never accepts
 * a command, cwd, repository, token, or environment from the model. Material
 * check/review/comment changes are published through the originating session's
 * privileged input port, where CLI/Desktop deliver them as Steer.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const watchers = new Map();
let watcherSequence = 0;

const VIEW_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'reviewDecision',
  'mergeStateStatus',
  'headRefOid',
  'statusCheckRollup',
  'latestReviews',
  'comments',
].join(',');

const FAILED_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'ERROR',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);

const bounded = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

const toId = (value) => bounded(value, 256);

export function normalizePullRequestSnapshot(raw) {
  const checks = Array.isArray(raw?.statusCheckRollup)
    ? raw.statusCheckRollup.slice(0, 100).map((check) => {
        const state = bounded(check?.status || check?.state || '', 40).toUpperCase();
        const reportedConclusion = bounded(check?.conclusion || '', 40).toUpperCase();
        const conclusion = reportedConclusion || (
          FAILED_CONCLUSIONS.has(state) || ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)
            ? state
            : ''
        );
        return {
          name: bounded(check?.name || check?.context || 'check', 160),
          workflow: bounded(check?.workflowName || '', 160),
          status: state,
          conclusion,
          url: bounded(check?.detailsUrl || check?.targetUrl || '', 2_000),
        };
      })
    : [];
  const failed = checks.filter((check) => FAILED_CONCLUSIONS.has(check.conclusion));
  const pending = checks.filter((check) =>
    !FAILED_CONCLUSIONS.has(check.conclusion)
    && check.conclusion !== 'SUCCESS'
    && check.conclusion !== 'NEUTRAL'
    && check.conclusion !== 'SKIPPED');
  const comments = Array.isArray(raw?.comments)
    ? raw.comments.slice(-50).map((comment) => ({
        id: toId(comment?.id || comment?.url),
        author: bounded(comment?.author?.login || 'unknown', 100),
        body: bounded(comment?.body || '', 1_000),
        url: bounded(comment?.url || '', 2_000),
      })).filter((comment) => comment.id)
    : [];
  const reviews = Array.isArray(raw?.latestReviews)
    ? raw.latestReviews.slice(-50).map((review) => ({
        id: toId(review?.id || `${review?.author?.login}:${review?.submittedAt}:${review?.state}`),
        author: bounded(review?.author?.login || 'unknown', 100),
        state: bounded(review?.state || '', 40).toUpperCase(),
        body: bounded(review?.body || '', 1_000),
        url: bounded(review?.url || '', 2_000),
      })).filter((review) => review.id)
    : [];
  return {
    number: Number(raw?.number) || 0,
    title: bounded(raw?.title || '', 240),
    url: bounded(raw?.url || '', 2_000),
    state: bounded(raw?.state || '', 40).toUpperCase(),
    isDraft: raw?.isDraft === true,
    reviewDecision: bounded(raw?.reviewDecision || '', 60).toUpperCase(),
    mergeStateStatus: bounded(raw?.mergeStateStatus || '', 60).toUpperCase(),
    headRefOid: bounded(raw?.headRefOid || '', 80),
    checks,
    failed,
    pending,
    comments,
    reviews,
    checksPassed: checks.length > 0 && failed.length === 0 && pending.length === 0,
  };
}

function listLines(items, render, max = 8) {
  return items.slice(-max).map(render).join('\n');
}

export function pullRequestTransitionEvents(previous, current) {
  const events = [];
  const headChanged = Boolean(previous && previous.headRefOid !== current.headRefOid);
  const previousFailures = new Set((previous?.failed ?? []).map((check) => `${check.workflow}:${check.name}:${check.conclusion}`));
  const newFailures = current.failed.filter((check) =>
    headChanged || !previousFailures.has(`${check.workflow}:${check.name}:${check.conclusion}`));

  if (newFailures.length > 0) {
    events.push({
      kind: 'checks-failed',
      label: `PR #${current.number} checks failed`,
      text: [
        `Pull request #${current.number} has failing checks. Inspect the failures, make the smallest valid fix, verify it, push the update, and keep the watcher active.`,
        `PR: ${current.title} ${current.url}`.trim(),
        listLines(newFailures, (check) =>
          `- ${check.workflow ? `${check.workflow}: ` : ''}${check.name} (${check.conclusion})${check.url ? ` ${check.url}` : ''}`),
      ].join('\n\n'),
    });
  } else if (current.checksPassed && (!previous?.checksPassed || headChanged)) {
    events.push({
      kind: 'checks-passed',
      label: `PR #${current.number} checks passed`,
      text: `All reported checks passed for pull request #${current.number} (${current.title}). Re-read any pending review feedback, then continue the normal merge or delivery workflow. ${current.url}`.trim(),
    });
  }

  const previousCommentIds = new Set((previous?.comments ?? []).map((comment) => comment.id));
  const newComments = current.comments.filter((comment) => !previousCommentIds.has(comment.id));
  if (newComments.length > 0) {
    events.push({
      kind: 'comments',
      label: `PR #${current.number} received comments`,
      text: [
        `Pull request #${current.number} has comments that were not yet observed by this watcher. Read them in context, decide which are actionable, and address valid feedback.`,
        listLines(newComments, (comment) =>
          `- @${comment.author}: ${comment.body || '(no body)'}${comment.url ? ` ${comment.url}` : ''}`, 5),
      ].join('\n\n'),
    });
  }

  const previousReviewIds = new Set((previous?.reviews ?? []).map((review) => review.id));
  const newReviews = current.reviews.filter((review) => !previousReviewIds.has(review.id));
  if (newReviews.length > 0 || current.reviewDecision !== (previous?.reviewDecision ?? '')) {
    events.push({
      kind: 'reviews',
      label: `PR #${current.number} review changed`,
      text: [
        `Pull request #${current.number} review state changed${current.reviewDecision ? ` to ${current.reviewDecision}` : ''}. Inspect the review before continuing.`,
        listLines(newReviews, (review) =>
          `- @${review.author}: ${review.state}${review.body ? ` — ${review.body}` : ''}${review.url ? ` ${review.url}` : ''}`, 5),
      ].filter(Boolean).join('\n\n'),
    });
  }

  if (previous) {
    if (previous.state === 'OPEN' && current.state !== 'OPEN') {
      events.push({
        kind: 'closed',
        label: `PR #${current.number} is ${current.state.toLowerCase()}`,
        text: `Pull request #${current.number} is now ${current.state.toLowerCase()}. Reconcile the active plan and stop any work that is no longer needed. ${current.url}`.trim(),
      });
    }
  }
  return events;
}

async function readSnapshot(workspaceRoot, number) {
  const args = ['pr', 'view'];
  if (number) args.push(String(number));
  args.push('--json', VIEW_FIELDS);
  const { stdout } = await execFileAsync('gh', args, {
    cwd: workspaceRoot,
    timeout: 15_000,
    maxBuffer: 2_000_000,
    windowsHide: true,
  });
  return normalizePullRequestSnapshot(JSON.parse(stdout));
}

function publishEvents(watcher, events) {
  for (const event of events) {
    watcher.port.publish(event.text, {
      id: `${watcher.id}:${event.kind}:${watcher.snapshot?.headRefOid || 'head'}:${Date.now().toString(36)}`,
      label: event.label,
    });
  }
}

function stopWatcher(watcher, status = 'stopped') {
  watcher.status = status;
  watcher.stoppedAt = Date.now();
  if (watcher.timer) clearTimeout(watcher.timer);
  watcher.timer = undefined;
}

function pruneWatchers(now = Date.now()) {
  for (const [id, watcher] of watchers) {
    if (watcher.status !== 'watching' && now - (watcher.stoppedAt || now) > 60 * 60_000) {
      watchers.delete(id);
    }
  }
  if (watchers.size <= 100) return;
  const stopped = [...watchers.values()]
    .filter((watcher) => watcher.status !== 'watching')
    .sort((a, b) => (a.stoppedAt || 0) - (b.stoppedAt || 0));
  while (watchers.size > 100 && stopped.length > 0) {
    watchers.delete(stopped.shift().id);
  }
}

function schedulePoll(watcher) {
  if (watcher.status !== 'watching') return;
  watcher.timer = setTimeout(() => { void pollWatcher(watcher); }, watcher.intervalMs);
  watcher.timer.unref?.();
}

async function pollWatcher(watcher) {
  if (watcher.status !== 'watching' || watcher.inFlight) return;
  if (Date.now() >= watcher.expiresAt) {
    stopWatcher(watcher, 'expired');
    return;
  }
  watcher.inFlight = true;
  try {
    const next = await readSnapshot(watcher.workspaceRoot, watcher.number);
    if (watcher.status !== 'watching') return;
    watcher.error = '';
    watcher.consecutiveErrors = 0;
    publishEvents(watcher, pullRequestTransitionEvents(watcher.snapshot, next));
    watcher.snapshot = next;
    watcher.lastPolledAt = new Date().toISOString();
    if (next.state !== 'OPEN') stopWatcher(watcher, 'completed');
  } catch (error) {
    watcher.consecutiveErrors++;
    watcher.error = bounded(error?.message || error, 1_000);
    if (watcher.consecutiveErrors >= 3) {
      watcher.port.publish(
        `Pull-request watcher ${watcher.id} stopped after repeated polling errors: ${watcher.error}. Check GitHub CLI authentication and repository access before starting it again.`,
        { id: `${watcher.id}:error`, label: 'Pull-request watcher stopped' },
      );
      stopWatcher(watcher, 'failed');
    }
  } finally {
    watcher.inFlight = false;
    schedulePoll(watcher);
  }
}

function watcherView(watcher) {
  return {
    id: watcher.id,
    pr: watcher.number,
    title: watcher.snapshot?.title || '',
    url: watcher.snapshot?.url || '',
    status: watcher.status,
    intervalSeconds: watcher.intervalMs / 1_000,
    expiresAt: new Date(watcher.expiresAt).toISOString(),
    lastPolledAt: watcher.lastPolledAt || null,
    checkSummary: watcher.snapshot ? {
      failed: watcher.snapshot.failed.length,
      pending: watcher.snapshot.pending.length,
      passed: watcher.snapshot.checksPassed,
      reviewDecision: watcher.snapshot.reviewDecision || null,
      comments: watcher.snapshot.comments.length,
      reviews: watcher.snapshot.reviews.length,
    } : null,
    error: watcher.error || null,
  };
}

const schema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'list', 'stop'], description: 'Start, list, or stop background pull-request watchers.' },
    number: { type: 'integer', minimum: 1, description: 'Pull-request number. Omit to resolve the current branch PR.' },
    id: { type: 'string', maxLength: 160, description: 'Watcher id from action="list"; required for stop.' },
    intervalSeconds: { type: 'integer', minimum: 10, maximum: 120, description: 'Polling interval. Default 15 seconds.' },
    maxMinutes: { type: 'integer', minimum: 1, maximum: 240, description: 'Maximum watch duration. Default 60 minutes.' },
  },
  required: ['action'],
  additionalProperties: false,
};

export async function activate(host) {
  host.registerTool({
    name: 'pull_request_watch',
    description:
      'Watch a GitHub pull request in the background while you continue working. After pushing or opening a PR, call action="start" once; do not manually loop or block on checks. The watcher reports failed/passed checks, new review decisions, and new comments back into this same session as Steer. Use action="list" or action="stop" to manage watchers.',
    inputSchema: schema,
    accessTier: 'read',
    actionKind: 'network',
    parallelSafe: false,
    audited: true,
    runtimePort: 'session-input',
    handle: async (args, runtime) => {
      pruneWatchers();
      const action = String(args.action || '');
      if (action === 'list') {
        return JSON.stringify({
          ok: true,
          watchers: [...watchers.values()]
            .filter((watcher) => watcher.workspaceRoot === host.workspaceRoot)
            .map(watcherView),
        });
      }
      if (action === 'stop') {
        const id = String(args.id || '').trim();
        const watcher = watchers.get(id);
        if (!watcher || watcher.workspaceRoot !== host.workspaceRoot) {
          return JSON.stringify({ ok: false, error: 'Unknown watcher id.' });
        }
        stopWatcher(watcher);
        return JSON.stringify({ ok: true, watcher: watcherView(watcher) });
      }
      if (action !== 'start') return JSON.stringify({ ok: false, error: 'Unknown action.' });
      if (!runtime?.sessionInputPort) {
        return JSON.stringify({ ok: false, error: 'Background session delivery is unavailable in this agent context.' });
      }
      const requestedNumber = Number(args.number);
      const number = Number.isInteger(requestedNumber) && requestedNumber > 0 ? requestedNumber : undefined;
      let snapshot;
      try {
        snapshot = await readSnapshot(host.workspaceRoot, number);
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: `Could not resolve the pull request: ${bounded(error?.message || error, 1_000)}`,
        });
      }
      const duplicate = [...watchers.values()].find((watcher) =>
        watcher.workspaceRoot === host.workspaceRoot
        && watcher.number === snapshot.number
        && watcher.status === 'watching');
      if (duplicate) return JSON.stringify({ ok: true, reused: true, watcher: watcherView(duplicate) });

      const intervalSeconds = Math.min(120, Math.max(10, Number(args.intervalSeconds) || 15));
      const maxMinutes = Math.min(240, Math.max(1, Number(args.maxMinutes) || 60));
      const watcher = {
        id: `pr-watch-${Date.now().toString(36)}-${++watcherSequence}`,
        workspaceRoot: host.workspaceRoot,
        number: snapshot.number,
        port: runtime.sessionInputPort,
        status: 'watching',
        intervalMs: intervalSeconds * 1_000,
        expiresAt: Date.now() + maxMinutes * 60_000,
        snapshot,
        timer: undefined,
        inFlight: false,
        consecutiveErrors: 0,
        error: '',
        lastPolledAt: new Date().toISOString(),
      };
      watchers.set(watcher.id, watcher);
      publishEvents(watcher, pullRequestTransitionEvents(null, snapshot));
      schedulePoll(watcher);
      return JSON.stringify({ ok: true, reused: false, watcher: watcherView(watcher) });
    },
  });
  host.log('registered pull_request_watch');
}
