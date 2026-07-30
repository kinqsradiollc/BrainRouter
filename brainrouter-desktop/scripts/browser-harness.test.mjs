import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  chromiumMajor,
  prepareElectronHarnessLayout,
  processTreeSample,
  startFixtureServer,
} from './browser-harness.mjs';

test('fixture is loopback-only and references only its own deterministic assets', async () => {
  const fixture = await startFixtureServer();
  try {
    assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(fixture.externalNetwork, false);
    const response = await fetch(`${fixture.origin}/fixture?id=test`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /data-fixture-id="test"/);
    assert.match(html, /src="\/fixture\.js"/);
    assert.match(html, /href="\/fixture\.css"/);
    assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
    const missing = await fetch(`${fixture.origin}/not-found`);
    assert.equal(missing.status, 404);
  } finally {
    await fixture.close();
  }
});

test('runtime version parsing never guesses a missing Chromium major', () => {
  assert.equal(chromiumMajor({ Browser: 'Chrome/150.0.7871.128' }), 150);
  assert.equal(chromiumMajor({ Browser: 'Electron/43.1.1' }), null);
  assert.equal(chromiumMajor(null), null);
});

test('process-tree sampler reports support explicitly', async () => {
  const sample = await processTreeSample(process.pid);
  assert.equal(typeof sample.supported, 'boolean');
  if (sample.supported) {
    assert.ok(sample.processCount >= 1);
    assert.ok(sample.rssBytes > 0);
    assert.ok(sample.cpuPercent >= 0);
  } else {
    assert.equal(typeof sample.reason, 'string');
    assert.ok(sample.reason.length > 0);
  }
});

test('Electron qualification starts from a hermetic valid installation', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-browser-layout-'));
  try {
    const layout = prepareElectronHarnessLayout(temporaryRoot);
    assert.equal(layout.home, path.join(temporaryRoot, 'home'));
    assert.equal(layout.state, path.join(temporaryRoot, 'state'));
    assert.ok(fs.statSync(layout.profile).isDirectory());
    assert.ok(fs.statSync(layout.workspace).isDirectory());
    assert.ok(fs.statSync(layout.state).isDirectory());
    const config = JSON.parse(fs.readFileSync(
      path.join(layout.home, '.config', 'brainrouter', 'config.json'),
      'utf8',
    ));
    assert.deepEqual(config, { activeServer: '', servers: {} });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
