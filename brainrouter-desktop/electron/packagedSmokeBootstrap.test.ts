/**
 * D26-9 — packaged browser smoke bootstrap contract.
 *
 * The test keeps the release-only DevTools seam loopback-bound, port-validated,
 * and inert for every ordinary Desktop launch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  configurePackagedSmokeDevTools,
  resolvePackagedSmokePort,
} from './packagedSmokeBootstrap.js';

test('D26-9 resolves only unprivileged TCP ports for packaged smoke', () => {
  assert.equal(resolvePackagedSmokePort('43821'), 43_821);
  for (const raw of [undefined, '', '0', '1023', '65536', '-1', '1.5', 'port']) {
    assert.equal(resolvePackagedSmokePort(raw), null, `Expected ${String(raw)} to be rejected.`);
  }
});

test('D26-9 configures loopback DevTools only for an explicit packaged smoke launch', () => {
  const profile = path.resolve('/tmp/brainrouter-packaged-smoke-profile');
  const switches: Array<[string, string | undefined]> = [];
  const app = {
    isPackaged: true,
    commandLine: {
      appendSwitch(name: string, value?: string): void {
        switches.push([name, value]);
      },
    },
  };

  assert.equal(configurePackagedSmokeDevTools(app, {}), false);
  assert.deepEqual(switches, []);
  assert.equal(
    configurePackagedSmokeDevTools(app, {
      BRAINROUTER_PACKAGED_SMOKE_PORT: '43821',
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: profile,
    }),
    true,
  );
  assert.deepEqual(switches, [
    ['user-data-dir', profile],
    ['remote-debugging-address', '127.0.0.1'],
    ['remote-debugging-port', '43821'],
  ]);
});

test('D26-9 refuses remote debugging without an absolute isolated profile', () => {
  const switches: Array<[string, string | undefined]> = [];
  const app = {
    isPackaged: true,
    commandLine: {
      appendSwitch(name: string, value?: string): void {
        switches.push([name, value]);
      },
    },
  };

  assert.equal(
    configurePackagedSmokeDevTools(app, { BRAINROUTER_PACKAGED_SMOKE_PORT: '43821' }),
    false,
  );
  assert.equal(
    configurePackagedSmokeDevTools(app, {
      BRAINROUTER_PACKAGED_SMOKE_PORT: '43821',
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: 'relative/profile',
    }),
    false,
  );
  assert.deepEqual(switches, []);
});

test('D26-9 ignores the packaged smoke seam in development', () => {
  const switches: Array<[string, string | undefined]> = [];
  const app = {
    isPackaged: false,
    commandLine: {
      appendSwitch(name: string, value?: string): void {
        switches.push([name, value]);
      },
    },
  };

  assert.equal(
    configurePackagedSmokeDevTools(app, {
      BRAINROUTER_PACKAGED_SMOKE_PORT: '43821',
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: path.resolve('/tmp/brainrouter-packaged-smoke-profile'),
    }),
    false,
  );
  assert.deepEqual(switches, []);
});
