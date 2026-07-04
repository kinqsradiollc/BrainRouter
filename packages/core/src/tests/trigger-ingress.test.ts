/**
 * MC-B1 — trigger ingress: opt-in node:http listener + mandatory per-provider
 * signature verification, all OFFLINE (ephemeral loopback port, injected
 * sink, no network beyond 127.0.0.1). Covers the security gates end-to-end:
 * valid HMAC → 200 + normalized event; bad/missing signature → 401 (before
 * the body is trusted); disabled → refuses to start (connection refused);
 * non-allowlisted repo → generic 202 drop; unknown provider → 404. Plus the
 * pure pieces: glob allowlist, GitHub normalization, config resolution, and
 * bounded+redacted payload persistence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  isRepoAllowed,
  normalizeGithubEvent,
  persistTriggerPayload,
  resolveGithubTriggerSecret,
  startTriggerServer,
  verifyGithubSignature,
  getTriggerProvider,
  listTriggerProviders,
  TRIGGER_PAYLOAD_MAX_BYTES,
  type TriggerEvent,
  type TriggerServerHandle,
} from '../triggers/index.js';
import { resolveCliKnobs } from '../config/config.js';
import { withTempWorkspaceAsync } from './_helpers.js';

const SECRET = 'wh_secret_for_tests';

function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function issueLabeledPayload(repo = 'acme/widgets'): string {
  return JSON.stringify({
    action: 'labeled',
    label: { name: 'brainrouter' },
    issue: { number: 41, title: 'Fix the flaky test' },
    repository: { full_name: repo },
    sender: { login: 'octocat' },
    // A secret-shaped string that must NOT land on disk verbatim:
    junk: 'token = ghp_0123456789abcdef0123456789abcdef',
  });
}

async function post(
  handle: TriggerServerHandle,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// End-to-end over a real (loopback, ephemeral-port) listener
// ---------------------------------------------------------------------------

test('MC-B1 ingress: valid signature → 200 + normalized event in the sink; payload persisted redacted', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const seen: TriggerEvent[] = [];
    const handle = await startTriggerServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0, // ephemeral — tests never squat the real default port
      allowedRepos: ['acme/*'],
      workspaceRoot: workspace,
      secrets: { github: SECRET },
      onEvent: (event) => { seen.push(event); },
    });
    try {
      const body = issueLabeledPayload();
      const { status, json } = await post(handle, '/triggers/github/events', body, {
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(body),
      });
      assert.equal(status, 200);
      assert.deepEqual(json, { ok: true });
      assert.equal(seen.length, 1);
      const event = seen[0];
      assert.equal(event.provider, 'github');
      assert.equal(event.kind, 'issue.labeled');
      assert.equal(event.repo, 'acme/widgets');
      assert.equal(event.number, 41);
      assert.equal(event.sender, 'octocat');
      assert.ok(event.receivedAt);
      // Raw payload persisted for the resolver — bounded + secret-redacted.
      assert.ok(event.payloadRef, 'payloadRef points at the persisted payload');
      const onDisk = fs.readFileSync(event.payloadRef, 'utf8');
      assert.ok(!onDisk.includes('ghp_0123456789abcdef'), 'token shape never lands on disk verbatim');
      assert.ok(onDisk.includes('«redacted»'), 'redaction marker present');
      assert.ok(onDisk.includes('Fix the flaky test'), 'non-secret content preserved');
    } finally {
      await handle.close();
    }
  });
});

test('MC-B1 ingress: bad signature → 401; missing signature → 401; sink never fires', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const seen: TriggerEvent[] = [];
    const handle = await startTriggerServer({
      enabled: true, host: '127.0.0.1', port: 0,
      allowedRepos: ['**'], workspaceRoot: workspace,
      secrets: { github: SECRET },
      onEvent: (event) => { seen.push(event); },
    });
    try {
      const body = issueLabeledPayload();
      // Wrong secret → invalid HMAC.
      const bad = await post(handle, '/triggers/github/events', body, {
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(body, 'the-wrong-secret'),
      });
      assert.equal(bad.status, 401);
      // No signature header at all → rejected before the body is trusted.
      const missing = await post(handle, '/triggers/github/events', body, {
        'x-github-event': 'issues',
      });
      assert.equal(missing.status, 401);
      // Malformed header shape.
      const malformed = await post(handle, '/triggers/github/events', body, {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=nothex',
      });
      assert.equal(malformed.status, 401);
      assert.equal(seen.length, 0, 'nothing reached the sink');
    } finally {
      await handle.close();
    }
  });
});

test('MC-B1 ingress: no secret configured → 401 fail-closed (never "skip verification")', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const seen: TriggerEvent[] = [];
    const handle = await startTriggerServer({
      enabled: true, host: '127.0.0.1', port: 0,
      allowedRepos: ['**'], workspaceRoot: workspace,
      secrets: {}, // github secret unset
      onEvent: (event) => { seen.push(event); },
    });
    try {
      const body = issueLabeledPayload();
      const res = await post(handle, '/triggers/github/events', body, {
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(body),
      });
      assert.equal(res.status, 401);
      assert.equal(seen.length, 0);
    } finally {
      await handle.close();
    }
  });
});

test('MC-B1 ingress: non-allowlisted repo → generic 202 drop (no repo leak); empty allowlist drops everything', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const seen: TriggerEvent[] = [];
    const handle = await startTriggerServer({
      enabled: true, host: '127.0.0.1', port: 0,
      allowedRepos: ['acme/*'], workspaceRoot: workspace,
      secrets: { github: SECRET },
      onEvent: (event) => { seen.push(event); },
    });
    try {
      const body = issueLabeledPayload('evil/probe');
      const res = await post(handle, '/triggers/github/events', body, {
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(body),
      });
      assert.equal(res.status, 202);
      assert.deepEqual(res.json, { accepted: true }, 'indistinguishable from an accepted delivery');
      assert.equal(seen.length, 0, 'dropped event never reaches the sink');
    } finally {
      await handle.close();
    }

    // Default allowlist ([]) → NOTHING is allowed.
    const strict = await startTriggerServer({
      enabled: true, host: '127.0.0.1', port: 0,
      workspaceRoot: workspace, secrets: { github: SECRET },
      onEvent: (event) => { seen.push(event); },
    });
    try {
      const body = issueLabeledPayload('acme/widgets');
      const res = await post(strict, '/triggers/github/events', body, {
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(body),
      });
      assert.equal(res.status, 202);
      assert.equal(seen.length, 0);
    } finally {
      await strict.close();
    }
  });
});

test('MC-B1 ingress: unknown provider → 404; unknown route → 404; GET → 405', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const handle = await startTriggerServer({
      enabled: true, host: '127.0.0.1', port: 0,
      allowedRepos: ['**'], workspaceRoot: workspace,
      secrets: { github: SECRET },
    });
    try {
      const body = issueLabeledPayload();
      const unknown = await post(handle, '/triggers/gitlab/events', body, {
        'x-hub-signature-256': sign(body),
      });
      assert.equal(unknown.status, 404, 'unregistered provider 404s (default-deny)');
      const noRoute = await post(handle, '/other/path', body, {});
      assert.equal(noRoute.status, 404);
      const get = await fetch(`http://127.0.0.1:${handle.port}/triggers/github/events`);
      assert.equal(get.status, 405);
    } finally {
      await handle.close();
    }
  });
});

test('MC-B1 ingress: disabled → refuses to start (nothing ever listens by default)', async () => {
  await assert.rejects(
    startTriggerServer({ enabled: false, port: 0 }),
    /disabled/i,
  );
  // The knob itself is default-deny: an empty config resolves to enabled=false.
  const knobs = resolveCliKnobs(undefined);
  assert.equal(knobs.triggers.enabled, false);
  assert.equal(knobs.triggers.port, 8787);
  assert.equal(knobs.triggers.host, '127.0.0.1');
  assert.equal(knobs.triggers.githubSecret, '');
  assert.deepEqual(knobs.triggers.allowedRepos, []);
});

test('MC-B1 config: cli.triggers validates — enabled requires explicit true, port clamped, junk dropped', () => {
  const cfg: any = {
    activeServer: '', servers: {},
    cli: {
      triggers: {
        enabled: 'yes', // truthy junk is NOT true
        port: 999_999,
        host: '  0.0.0.0  ',
        githubSecret: '  s3cret  ',
        allowedRepos: ['acme/*', '', 42],
      },
    },
  };
  const knobs = resolveCliKnobs(cfg);
  assert.equal(knobs.triggers.enabled, false, 'only an explicit boolean true enables');
  assert.equal(knobs.triggers.port, 65_535, 'out-of-range port clamps into the valid range');
  assert.equal(resolveCliKnobs({ activeServer: '', servers: {}, cli: { triggers: { port: Number.NaN } } } as any).triggers.port, 8787, 'junk port → default');
  assert.equal(knobs.triggers.host, '0.0.0.0');
  assert.equal(knobs.triggers.githubSecret, 's3cret');
  assert.deepEqual(knobs.triggers.allowedRepos, ['acme/*']);
  const onCfg: any = { activeServer: '', servers: {}, cli: { triggers: { enabled: true, port: 9000 } } };
  const on = resolveCliKnobs(onCfg);
  assert.equal(on.triggers.enabled, true);
  assert.equal(on.triggers.port, 9000);
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test('MC-B1 signature: HMAC verify is fail-closed on every edge', () => {
  const rawBody = Buffer.from('{"a":1}');
  const good = { 'x-hub-signature-256': sign(rawBody.toString()) };
  assert.equal(verifyGithubSignature({ headers: good, rawBody, secret: SECRET }), true);
  assert.equal(verifyGithubSignature({ headers: good, rawBody, secret: '' }), false, 'unset secret → false');
  assert.equal(verifyGithubSignature({ headers: {}, rawBody, secret: SECRET }), false, 'missing header → false');
  assert.equal(
    verifyGithubSignature({ headers: { 'x-hub-signature-256': 'sha1=abc' }, rawBody, secret: SECRET }),
    false,
    'non-sha256 scheme → false',
  );
  assert.equal(
    verifyGithubSignature({ headers: good, rawBody: Buffer.from('{"a":2}'), secret: SECRET }),
    false,
    'body tamper → false',
  );
});

test('MC-B1 normalize: github event/action pairs map onto neutral kinds', () => {
  const headers = (event: string) => ({ 'x-github-event': event });
  const base = { repository: { full_name: 'acme/w' }, sender: { login: 'u' } };
  assert.equal(normalizeGithubEvent(headers('issues'), { ...base, action: 'labeled', issue: { number: 7 } })?.kind, 'issue.labeled');
  assert.equal(normalizeGithubEvent(headers('issue_comment'), { ...base, action: 'created', issue: { number: 7 } })?.kind, 'comment.created');
  assert.equal(normalizeGithubEvent(headers('pull_request_review_comment'), { ...base, action: 'created', pull_request: { number: 8 } })?.kind, 'review.comment');
  assert.equal(normalizeGithubEvent(headers('workflow_run'), { ...base, action: 'completed' })?.kind, 'workflow_run.completed');
  assert.equal(normalizeGithubEvent(headers('ping'), base)?.kind, 'ping');
  // Unmapped pairs keep a `<event>.<action>` shape (open union).
  assert.equal(normalizeGithubEvent(headers('pull_request'), { ...base, action: 'synchronize', pull_request: { number: 9 } })?.kind, 'pull_request.synchronize');
  // PR number flows through the pull_request field.
  assert.equal(normalizeGithubEvent(headers('pull_request'), { ...base, action: 'opened', pull_request: { number: 9 } })?.number, 9);
  // No event header → nothing actionable.
  assert.equal(normalizeGithubEvent({}, base), null);
});

test('MC-B1 allowlist: glob semantics + fail-closed edges', () => {
  assert.equal(isRepoAllowed('acme/widgets', ['acme/*']), true);
  assert.equal(isRepoAllowed('acme/widgets', ['acme/widgets']), true);
  assert.equal(isRepoAllowed('ACME/Widgets', ['acme/widgets']), true, 'repo slugs compare case-insensitively');
  assert.equal(isRepoAllowed('other/widgets', ['acme/*']), false);
  assert.equal(isRepoAllowed('acme/a/b', ['acme/*']), false, '`*` stays within one segment');
  assert.equal(isRepoAllowed('acme/a/b', ['acme/**']), true, '`**` crosses segments');
  assert.equal(isRepoAllowed('acme/widgets', []), false, 'empty allowlist allows nothing');
  assert.equal(isRepoAllowed('', ['**']), false, 'repo-less events are never allowed');
});

test('MC-B1 payload store: bounded + redacted; secret resolution prefers the explicit knob', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const oversize = Buffer.from('x'.repeat(TRIGGER_PAYLOAD_MAX_BYTES + 4096));
    const ref = persistTriggerPayload(workspace, 'github', oversize);
    assert.ok(ref);
    assert.ok(fs.statSync(ref).size <= TRIGGER_PAYLOAD_MAX_BYTES, 'payload bounded on disk');

    // Secret resolution: explicit knob wins; no knob + no connector → ''.
    assert.equal(resolveGithubTriggerSecret({ configSecret: ' knob ' }), 'knob');
    assert.equal(resolveGithubTriggerSecret({ workspaceRoot: workspace }), '');
    assert.equal(resolveGithubTriggerSecret({}), '');
  });
});

test('MC-B1 registry: github is built-in; unknown names miss; lookup is case-insensitive', () => {
  assert.ok(getTriggerProvider('github'));
  assert.ok(getTriggerProvider('GitHub'));
  assert.equal(getTriggerProvider('gitlab'), undefined, 'MC-B7 territory — not registered yet');
  assert.ok(listTriggerProviders().includes('github'));
});
