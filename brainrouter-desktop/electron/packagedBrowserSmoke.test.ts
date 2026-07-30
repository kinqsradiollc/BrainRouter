import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPackagedBrowserSmokeIfRequested } from './packagedBrowserSmoke.js';

function smokeEnv(root: string): NodeJS.ProcessEnv {
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  return {
    BRAINROUTER_PACKAGED_SMOKE_PROFILE: profile,
    BRAINROUTER_PACKAGED_SMOKE_RESULT: path.join(profile, 'result.json'),
  };
}

test('D26-9 packaged self-test writes the renderer bridge result and quits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-packaged-smoke-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = smokeEnv(root);
  let quitCount = 0;
  const smoke = { bridge: true, finalCount: 2 };
  const ran = await runPackagedBrowserSmokeIfRequested(
    { isPackaged: true, quit: () => { quitCount += 1; } },
    {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        once: () => undefined,
        executeJavaScript: async () => smoke,
      },
    },
    env,
  );

  assert.equal(ran, true);
  assert.equal(quitCount, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(env.BRAINROUTER_PACKAGED_SMOKE_RESULT!, 'utf8')),
    { ok: true, smoke },
  );
});

test('D26-9 packaged self-test records a bounded renderer failure and quits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-packaged-smoke-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = smokeEnv(root);
  let quitCount = 0;
  const ran = await runPackagedBrowserSmokeIfRequested(
    { isPackaged: true, quit: () => { quitCount += 1; } },
    {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        once: () => undefined,
        executeJavaScript: async () => { throw new Error('renderer failed'); },
      },
    },
    env,
  );

  assert.equal(ran, true);
  assert.equal(quitCount, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(env.BRAINROUTER_PACKAGED_SMOKE_RESULT!, 'utf8')),
    { ok: false, error: 'renderer failed' },
  );
});

test('D26-9 packaged self-test remains inert outside the explicit release seam', async () => {
  let executed = false;
  const ran = await runPackagedBrowserSmokeIfRequested(
    { isPackaged: false, quit: () => assert.fail('ordinary launches must not quit') },
    {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        once: () => undefined,
        executeJavaScript: async () => {
          executed = true;
          return null;
        },
      },
    },
    {},
  );
  assert.equal(ran, false);
  assert.equal(executed, false);
});
