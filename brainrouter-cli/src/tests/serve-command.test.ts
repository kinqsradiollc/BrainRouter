/** MC-B1 — `brainrouter serve --triggers` gating helpers (pure, default-deny). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateServeInvocation,
  resolveServeBind,
  serveStartupWarnings,
  type ServeTriggersKnobs,
} from '../runtime/triggers/serveCommand.js';

function knobs(over: Partial<ServeTriggersKnobs> = {}): ServeTriggersKnobs {
  return {
    enabled: false,
    port: 8787,
    host: '127.0.0.1',
    githubSecret: '',
    slackSigningSecret: '',
    gitlabSecret: '',
    jiraSecret: '',
    allowedRepos: [],
    ...over,
  };
}

test('serve is default-deny: no --triggers → error; cli.triggers.enabled=false → error', () => {
  assert.match(validateServeInvocation({}, knobs({ enabled: true }))!, /pass --triggers/);
  assert.match(
    validateServeInvocation({ triggers: true }, knobs())!,
    /cli\.triggers\.enabled/,
    'the knob defaults to false and blocks the listener',
  );
  assert.equal(validateServeInvocation({ triggers: true }, knobs({ enabled: true })), null);
});

test('resolveServeBind: flags override knobs; junk falls back to the knobs', () => {
  const k = knobs({ port: 9000, host: '10.0.0.1' });
  assert.deepEqual(resolveServeBind({}, k), { host: '10.0.0.1', port: 9000 });
  assert.deepEqual(resolveServeBind({ port: '8080', host: ' 0.0.0.0 ' }, k), { host: '0.0.0.0', port: 8080 });
  assert.deepEqual(resolveServeBind({ port: 'nonsense', host: '  ' }, k), { host: '10.0.0.1', port: 9000 });
  assert.deepEqual(resolveServeBind({ port: '999999' }, k), { host: '10.0.0.1', port: 9000 });
});

test('serveStartupWarnings surfaces empty allowlist + missing secret (never fatal)', () => {
  const bare = serveStartupWarnings(knobs({ enabled: true }), { github: '', slack: '', gitlab: '', jira: '' });
  assert.equal(bare.length, 5);
  assert.match(bare[0], /allowedRepos is empty/);
  assert.match(bare[1], /rejected \(401\)/);
  assert.match(bare[2], /rejected \(401\)/);
  assert.match(bare[3], /rejected \(401\)/);
  assert.match(bare[4], /rejected \(401\)/);
  const ready = serveStartupWarnings(
    knobs({ enabled: true, allowedRepos: ['acme/*'] }),
    { github: 's3cret', slack: 's3cret', gitlab: 's3cret', jira: 's3cret' },
  );
  assert.deepEqual(ready, []);
});
