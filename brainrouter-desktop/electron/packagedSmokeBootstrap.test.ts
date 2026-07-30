/**
 * D26-9 — packaged browser smoke bootstrap contract.
 *
 * The test keeps the release-only self-test isolated from the user's normal
 * profile and inert for every ordinary Desktop launch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  configurePackagedSmokeProfile,
  resolvePackagedSmokeConfig,
} from './packagedSmokeBootstrap.js';

test('D26-9 configures an isolated profile only for an explicit packaged smoke launch', () => {
  const profile = path.resolve('/tmp/brainrouter-packaged-smoke-profile');
  const result = path.join(profile, 'result.json');
  const switches: Array<[string, string | undefined]> = [];
  const app = {
    isPackaged: true,
    commandLine: {
      appendSwitch(name: string, value?: string): void {
        switches.push([name, value]);
      },
    },
  };

  assert.equal(configurePackagedSmokeProfile(app, {}), false);
  assert.deepEqual(switches, []);
  assert.equal(
    configurePackagedSmokeProfile(app, {
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: profile,
      BRAINROUTER_PACKAGED_SMOKE_RESULT: result,
    }),
    true,
  );
  assert.deepEqual(switches, [['user-data-dir', profile]]);
});

test('D26-9 accepts only a result directly inside an absolute isolated profile', () => {
  const profile = path.resolve('/tmp/brainrouter-packaged-smoke-profile');
  assert.deepEqual(
    resolvePackagedSmokeConfig({
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: profile,
      BRAINROUTER_PACKAGED_SMOKE_RESULT: path.join(profile, 'result.json'),
    }),
    { profile, result: path.join(profile, 'result.json') },
  );
  for (const env of [
    {},
    { BRAINROUTER_PACKAGED_SMOKE_PROFILE: profile },
    {
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: 'relative/profile',
      BRAINROUTER_PACKAGED_SMOKE_RESULT: path.join(profile, 'result.json'),
    },
    {
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: profile,
      BRAINROUTER_PACKAGED_SMOKE_RESULT: path.resolve('/tmp/outside.json'),
    },
    {
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: profile,
      BRAINROUTER_PACKAGED_SMOKE_RESULT: path.join(profile, 'nested', 'result.json'),
    },
  ]) {
    assert.equal(resolvePackagedSmokeConfig(env), null);
  }
});

test('D26-9 refuses the packaged smoke launch without its complete isolated contract', () => {
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
    configurePackagedSmokeProfile(app, {
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: path.resolve('/tmp/brainrouter-packaged-smoke-profile'),
    }),
    false,
  );
  assert.equal(
    configurePackagedSmokeProfile(app, {
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: 'relative/profile',
      BRAINROUTER_PACKAGED_SMOKE_RESULT: path.resolve('/tmp/result.json'),
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
    configurePackagedSmokeProfile(app, {
      BRAINROUTER_PACKAGED_SMOKE_PROFILE: path.resolve('/tmp/brainrouter-packaged-smoke-profile'),
      BRAINROUTER_PACKAGED_SMOKE_RESULT: path.resolve('/tmp/brainrouter-packaged-smoke-profile/result.json'),
    }),
    false,
  );
  assert.deepEqual(switches, []);
});
