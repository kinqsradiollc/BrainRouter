import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBrowserSmokeCommand,
  classifyArtifacts,
  runBrowserSmoke,
  formatBrowserSmokeResult,
} from '../runtime/browserVerify.js';

test('buildBrowserSmokeCommand substitutes {url}/{out} and the ${...} variants', () => {
  assert.equal(
    buildBrowserSmokeCommand('smoke --url {url} --out {out}', { url: 'http://x', outDir: '/tmp/o' }),
    'smoke --url http://x --out /tmp/o',
  );
  assert.equal(
    buildBrowserSmokeCommand('smoke ${url} ${out}', { url: 'http://x', outDir: '/tmp/o' }),
    'smoke http://x /tmp/o',
  );
  // multiple occurrences all replaced
  assert.equal(buildBrowserSmokeCommand('{url} {url}', { url: 'u', outDir: 'o' }), 'u u');
});

test('classifyArtifacts buckets by extension', () => {
  const a = classifyArtifacts([
    '/o/home.png', '/o/flow.JPEG', '/o/run.webm', '/o/console.log',
    '/o/network.har', '/o/trace.json', '/o/notes.md', '/o/Makefile',
  ]);
  assert.deepEqual(a.screenshots, ['/o/home.png', '/o/flow.JPEG']);
  assert.deepEqual(a.videos, ['/o/run.webm']);
  assert.deepEqual(a.logs, ['/o/console.log', '/o/network.har', '/o/trace.json']);
  assert.deepEqual(a.other, ['/o/notes.md', '/o/Makefile']);
});

test('runBrowserSmoke errors when unconfigured', () => {
  const r = runBrowserSmoke('', { url: 'http://x', outDir: '/o', cwd: '/w' }, () => ({ exitCode: 0, output: '' }), () => []);
  assert.ok('error' in r);
});

test('runBrowserSmoke runs the command and collects artifacts', () => {
  let ranCommand = '';
  const exec = (command: string) => { ranCommand = command; return { exitCode: 0, output: 'smoke ok' }; };
  const list = () => ['/o/a.png', '/o/b.log'];
  const r = runBrowserSmoke('play {url} {out}', { url: 'http://localhost:3000', outDir: '/o', cwd: '/w' }, exec, list);
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(ranCommand, 'play http://localhost:3000 /o');
  assert.equal(r.ok, true);
  assert.equal(r.artifacts.screenshots.length, 1);
  assert.equal(r.artifacts.logs.length, 1);
});

test('runBrowserSmoke reports a failed smoke (non-zero exit) without throwing', () => {
  const exec = () => ({ exitCode: 2, output: 'assertion failed' });
  const r = runBrowserSmoke('play', { url: 'http://x', outDir: '/o', cwd: '/w' }, exec, () => []);
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
});

test('formatBrowserSmokeResult summarizes counts + artifacts', () => {
  const lines = formatBrowserSmokeResult({
    command: 'play', url: 'http://x', outDir: '/o', ok: true, exitCode: 0, output: 'done',
    artifacts: { screenshots: ['/o/a.png'], videos: [], logs: ['/o/b.log'], other: [] },
  });
  assert.match(lines[0], /✓ browser smoke: http:\/\/x/);
  assert.match(lines.join('\n'), /1 screenshot\(s\)/);
  assert.match(lines.join('\n'), /\/o\/a\.png/);
});
