import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '@kinqs/brainrouter-core/util';
import {
  _setGlobalSetupCommitHookForTests,
  _setGlobalSetupRollbackHookForTests,
  _setGlobalSetupTransactionHookForTests,
  isOnboarded,
  isRegularFileNoFollow,
  persistGlobalSetupOrThrow,
  recoverGlobalSetupState,
  updateGlobalSetupConfigOrThrow,
  type GlobalSetupPersistence,
} from '../cli/wizard/globalPersistence.js';

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

test('global onboarding requires an existing regular marker file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-marker-'));
  const markerPath = path.join(root, '.onboarded');
  try {
    assert.equal(isOnboarded(markerPath), false, 'an absent marker is not ready');
    assert.equal(isRegularFileNoFollow(markerPath), false);
    fs.mkdirSync(markerPath);
    assert.equal(isOnboarded(markerPath), false, 'a directory cannot act as the marker');
    assert.equal(isRegularFileNoFollow(markerPath), false);
    fs.rmSync(markerPath, { recursive: true });
    fs.writeFileSync(markerPath, '');
    assert.equal(isOnboarded(markerPath), true, 'a regular marker file is ready');
    assert.equal(isRegularFileNoFollow(markerPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global onboarding never follows live or dangling marker symlinks', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-marker-link-'));
  const markerPath = path.join(root, '.onboarded');
  const external = path.join(root, 'external');
  try {
    fs.writeFileSync(external, 'ready');
    fs.symlinkSync(external, markerPath);
    assert.equal(isOnboarded(markerPath), false, 'a live symlink cannot act as the marker');
    assert.equal(isRegularFileNoFollow(markerPath), false);

    fs.rmSync(markerPath);
    fs.symlinkSync(path.join(root, 'missing'), markerPath);
    assert.equal(isOnboarded(markerPath), false, 'a dangling symlink cannot act as the marker');
    assert.equal(isRegularFileNoFollow(markerPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global setup restores exact config/marker bytes and modes when marker commit fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-setup-'));
  const directory = path.join(root, 'config');
  const configPath = path.join(directory, 'config.json');
  const markerPath = path.join(directory, '.onboarded');
  fs.mkdirSync(directory, { recursive: true });
  const oldConfig = Buffer.from('{"existing":true}\n');
  const oldMarker = Buffer.from('already-ready\n');
  fs.writeFileSync(configPath, oldConfig, { mode: 0o640 });
  fs.writeFileSync(markerPath, oldMarker, { mode: 0o604 });
  fs.chmodSync(configPath, 0o640);
  fs.chmodSync(markerPath, 0o604);
  const markerInode = fs.statSync(markerPath).ino;

  const persistence: GlobalSetupPersistence = {
    configPath,
    markerPath,
    saveConfig: (config) => writeFileAtomic(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeMarker: () => writeFileAtomic(markerPath, '', {
      mode: 0o600,
      beforeCommit: () => { throw new Error('marker denied'); },
    }),
  };

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow({ activeServer: '', servers: {} }, persistence),
      /marker denied/,
    );
    assert.deepEqual(fs.readFileSync(configPath), oldConfig);
    assert.deepEqual(fs.readFileSync(markerPath), oldMarker);
    assert.equal(mode(configPath), 0o640);
    assert.equal(mode(markerPath), 0o604);
    assert.equal(
      fs.statSync(markerPath).ino,
      markerInode,
      'a marker writer that fails before commit must not replace the untouched marker',
    );
    assert.deepEqual(
      fs.readdirSync(directory).sort(),
      ['.onboarded', 'config.json'],
      'failed atomic writes and rollback must leave no temporary files',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global setup removes fresh config and temporary files when marker commit fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-setup-fresh-'));
  const directory = path.join(root, 'nested', 'config');
  const configPath = path.join(directory, 'config.json');
  const markerPath = path.join(directory, '.onboarded');
  const persistence: GlobalSetupPersistence = {
    configPath,
    markerPath,
    saveConfig: (config) => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileAtomic(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    },
    writeMarker: () => writeFileAtomic(markerPath, '', {
      mode: 0o600,
      beforeCommit: () => { throw new Error('marker denied'); },
    }),
  };

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow({ activeServer: '', servers: {} }, persistence),
      /marker denied/,
    );
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(fs.existsSync(directory), false, 'new empty config directory should roll back');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global setup refuses to snapshot a symlinked config target', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-setup-link-'));
  const external = path.join(root, 'external.json');
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(external, 'keep\n');
  fs.symlinkSync(external, configPath);
  let writes = 0;

  try {
    assert.throws(() => persistGlobalSetupOrThrow(
      { activeServer: '', servers: {} },
      {
        configPath,
        markerPath,
        saveConfig: () => { writes += 1; },
        writeMarker: () => { writes += 1; },
      },
    ), /Unsafe global setup file/);
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(external, 'utf8'), 'keep\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global setup update rejects a config replacement raced after its load baseline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-setup-load-race-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"activeServer":"old","servers":{}}\n', { mode: 0o600 });
  fs.writeFileSync(markerPath, 'ready\n', { mode: 0o600 });
  let configWrites = 0;
  let markerWrites = 0;
  const persistence: GlobalSetupPersistence = {
    configPath,
    markerPath,
    saveConfig: () => { configWrites += 1; },
    writeMarker: () => { markerWrites += 1; },
  };

  try {
    assert.throws(
      () => updateGlobalSetupConfigOrThrow(
        (current) => ({ ...current, activeServer: 'wizard' }),
        {
          persistence,
          loadConfig: () => {
            const loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            writeFileAtomic(
              configPath,
              '{"activeServer":"concurrent","servers":{"github":{"type":"http","url":"https://example.test/mcp"}}}\n',
              { mode: 0o600 },
            );
            return loaded;
          },
        },
      ),
      /changed while setup was being reviewed/,
    );
    assert.equal(configWrites, 0);
    assert.equal(markerWrites, 0);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).activeServer, 'concurrent');
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'ready\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global setup leaves untouched file inodes alone when the first writer fails before touching disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-setup-untouched-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"keep":true}\n');
  fs.writeFileSync(markerPath, 'ready\n');
  const configInode = fs.statSync(configPath).ino;
  const markerInode = fs.statSync(markerPath).ino;
  let markerWrites = 0;

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow(
        { activeServer: '', servers: {} },
        {
          configPath,
          markerPath,
          saveConfig: () => { throw new Error('config denied before write'); },
          writeMarker: () => { markerWrites += 1; },
        },
      ),
      /config denied before write/,
    );
    assert.equal(fs.statSync(configPath).ino, configInode);
    assert.equal(fs.statSync(markerPath).ino, markerInode);
    assert.equal(markerWrites, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global setup preserves an unowned partial config and reports rollback incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-setup-partial-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"old":true}\n');
  fs.writeFileSync(markerPath, 'ready\n');
  const markerInode = fs.statSync(markerPath).ino;

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow(
        { activeServer: '', servers: {} },
        {
          configPath,
          markerPath,
          saveConfig: () => {
            fs.writeFileSync(configPath, '{"partial":');
            throw new Error('config writer failed');
          },
          writeMarker: () => { throw new Error('marker must not run'); },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /rollback was incomplete: config writer failed/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{"partial":');
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'ready\n');
    assert.equal(fs.statSync(markerPath).ino, markerInode, 'the unattempted marker remains the same inode');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global setup preserves a concurrent config replacement during marker failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-setup-concurrent-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"old":true}\n');
  fs.writeFileSync(markerPath, 'ready\n');
  const markerInode = fs.statSync(markerPath).ino;

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow(
        { activeServer: '', servers: {} },
        {
          configPath,
          markerPath,
          saveConfig: (config) => writeFileAtomic(
            configPath,
            `${JSON.stringify(config)}\n`,
            { mode: 0o600 },
          ),
          writeMarker: () => {
            writeFileAtomic(configPath, '{"concurrent":true}\n', { mode: 0o640 });
            throw new Error('marker failed after concurrent config edit');
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /rollback was incomplete: marker failed after concurrent config edit/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{"concurrent":true}\n');
    assert.equal(mode(configPath), 0o640);
    assert.equal(fs.statSync(markerPath).ino, markerInode);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global rollback quarantines and restores a replacement raced between verification and removal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-setup-remove-race-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  let hookCalls = 0;
  _setGlobalSetupRollbackHookForTests((event) => {
    if (event.target !== configPath) return;
    hookCalls += 1;
    writeFileAtomic(configPath, '{"concurrent":true}\n', { mode: 0o640 });
  });

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow(
        { activeServer: '', servers: {} },
        {
          configPath,
          markerPath,
          saveConfig: (config) => writeFileAtomic(
            configPath,
            `${JSON.stringify(config)}\n`,
            { mode: 0o600 },
          ),
          writeMarker: () => { throw new Error('marker failed before write'); },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /rollback was incomplete: marker failed before write/);
        return true;
      },
    );
    assert.equal(hookCalls, 1);
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{"concurrent":true}\n');
    assert.equal(mode(configPath), 0o640);
    assert.equal(
      fs.readdirSync(root).some((name) => name.endsWith('.rollback')),
      false,
      'the verified hard-link restore must not leave a quarantine behind',
    );
  } finally {
    _setGlobalSetupRollbackHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global config commit CAS preserves a replacement written after the initial snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-config-claim-race-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"old":true}\n');
  fs.writeFileSync(markerPath, 'ready\n');
  let hookCalls = 0;
  _setGlobalSetupCommitHookForTests((event) => {
    if (event.target !== configPath) return;
    hookCalls += 1;
    writeFileAtomic(configPath, '{"concurrent":true}\n', { mode: 0o640 });
  });

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow(
        { activeServer: '', servers: {} },
        {
          configPath,
          markerPath,
          saveConfig: (config, options) => writeFileAtomic(
            configPath,
            `${JSON.stringify(config)}\n`,
            { mode: 0o600, exclusive: options?.exclusive },
          ),
          writeMarker: (options) => writeFileAtomic(markerPath, '', {
            mode: 0o600,
            exclusive: options?.exclusive,
          }),
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Setup file changed immediately before save/);
        return true;
      },
    );
    assert.equal(hookCalls, 1);
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{"concurrent":true}\n');
    assert.equal(mode(configPath), 0o640);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'ready\n');
  } finally {
    _setGlobalSetupCommitHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global marker commit CAS preserves a replacement and rolls back the owned config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-marker-claim-race-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"old":true}\n', { mode: 0o640 });
  fs.writeFileSync(markerPath, 'old-ready\n', { mode: 0o604 });
  _setGlobalSetupCommitHookForTests((event) => {
    if (event.target === markerPath) {
      writeFileAtomic(markerPath, 'concurrent-ready\n', { mode: 0o640 });
    }
  });

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow(
        { activeServer: '', servers: {} },
        {
          configPath,
          markerPath,
          saveConfig: (config, options) => writeFileAtomic(
            configPath,
            `${JSON.stringify(config)}\n`,
            { mode: 0o600, exclusive: options?.exclusive },
          ),
          writeMarker: (options) => writeFileAtomic(markerPath, '', {
            mode: 0o600,
            exclusive: options?.exclusive,
          }),
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Setup file changed immediately before save/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{"old":true}\n');
    assert.equal(mode(configPath), 0o640);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'concurrent-ready\n');
    assert.equal(mode(markerPath), 0o640);
  } finally {
    _setGlobalSetupCommitHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live global receipt survives recovery in the pre-rename window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-live-receipt-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"old":true}\n');
  fs.writeFileSync(markerPath, 'ready\n');
  let recovered = false;
  _setGlobalSetupCommitHookForTests((event) => {
    if (recovered || event.stage !== 'before-write-claim' || event.target !== configPath) return;
    recovered = true;
    recoverGlobalSetupState(configPath, markerPath);
  });

  try {
    persistGlobalSetupOrThrow(
      { activeServer: '', servers: {} },
      {
        configPath,
        markerPath,
        saveConfig: (config, options) => writeFileAtomic(
          configPath,
          `${JSON.stringify(config)}\n`,
          { mode: 0o600, exclusive: options?.exclusive },
        ),
        writeMarker: (options) => writeFileAtomic(markerPath, '', {
          mode: 0o600,
          exclusive: options?.exclusive,
        }),
      },
    );
    assert.equal(recovered, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      activeServer: '',
      servers: {},
    });
    assert.deepEqual(fs.readdirSync(root).sort(), ['.onboarded', 'config.json']);
  } finally {
    _setGlobalSetupCommitHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const interrupted of ['config', 'marker'] as const) {
  test(`global recovery restores an interrupted ${interrupted} claim before readiness`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `br-global-${interrupted}-crash-`));
    const configPath = path.join(root, 'config.json');
    const markerPath = path.join(root, '.onboarded');
    const oldConfig = '{"old":true}\n';
    const oldMarker = 'old-ready\n';
    fs.writeFileSync(configPath, oldConfig);
    fs.writeFileSync(markerPath, oldMarker);
    const interruptedPath = interrupted === 'config' ? configPath : markerPath;
    _setGlobalSetupCommitHookForTests((event) => {
      if (event.stage === 'after-write-claim' && event.target === interruptedPath) {
        throw new Error(`simulated ${interrupted} process interruption`);
      }
    });

    try {
      assert.throws(
        () => persistGlobalSetupOrThrow(
          { activeServer: '', servers: {} },
          {
            configPath,
            markerPath,
            saveConfig: (config, options) => writeFileAtomic(
              configPath,
              `${JSON.stringify(config)}\n`,
              { mode: 0o600, exclusive: options?.exclusive },
            ),
            writeMarker: (options) => writeFileAtomic(markerPath, '', {
              mode: 0o600,
              exclusive: options?.exclusive,
            }),
          },
        ),
        new RegExp(`simulated ${interrupted} process interruption|rollback was incomplete`),
      );
      assert.equal(fs.existsSync(interruptedPath), false);
      _setGlobalSetupCommitHookForTests(undefined);
      recoverGlobalSetupState(configPath, markerPath);
      assert.equal(fs.readFileSync(configPath, 'utf8'), oldConfig);
      assert.equal(fs.readFileSync(markerPath, 'utf8'), oldMarker);
      assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.claim')), false);
      assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.claim-receipt.json')), false);
    } finally {
      _setGlobalSetupCommitHookForTests(undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('global recovery retires a claim when a prior recovery already linked the same inode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-same-inode-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"old":true}\n');
  fs.writeFileSync(markerPath, 'ready\n');
  _setGlobalSetupCommitHookForTests((event) => {
    if (event.stage === 'after-write-claim' && event.target === configPath) {
      throw new Error('simulated recovery-link crash');
    }
  });

  try {
    assert.throws(() => persistGlobalSetupOrThrow(
      { activeServer: '', servers: {} },
      {
        configPath,
        markerPath,
        saveConfig: () => { throw new Error('not reached'); },
        writeMarker: () => { throw new Error('not reached'); },
      },
    ), /simulated recovery-link crash|rollback was incomplete/);
    _setGlobalSetupCommitHookForTests(undefined);
    const claimName = fs.readdirSync(root).find((name) => name.endsWith('.claim'));
    assert.ok(claimName);
    const claimPath = path.join(root, claimName);
    fs.linkSync(claimPath, configPath);
    recoverGlobalSetupState(configPath, markerPath);
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{"old":true}\n');
    assert.equal(fs.existsSync(claimPath), false);
  } finally {
    _setGlobalSetupCommitHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global coordinator restores the exact pre-state after death before config claim cleanup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-post-write-rollback-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  const oldConfig = Buffer.from('{"apiKey":"prior-secret","keep":true}\n');
  const oldMarker = Buffer.from('old-ready\n');
  fs.writeFileSync(configPath, oldConfig, { mode: 0o640 });
  fs.writeFileSync(markerPath, oldMarker, { mode: 0o604 });
  fs.chmodSync(configPath, 0o640);
  fs.chmodSync(markerPath, 0o604);
  _setGlobalSetupCommitHookForTests((event) => {
    if (event.stage === 'after-write-replacement' && event.target === configPath) {
      throw new Error('simulated death before config claim cleanup');
    }
  });

  try {
    assert.throws(
      () => persistGlobalSetupOrThrow(
        { activeServer: '', servers: {} },
        {
          configPath,
          markerPath,
          saveConfig: (config, options) => writeFileAtomic(
            configPath,
            `${JSON.stringify(config, null, 2)}\n`,
            { mode: 0o600, exclusive: options?.exclusive },
          ),
          writeMarker: (options) => writeFileAtomic(markerPath, '', {
            mode: 0o600,
            exclusive: options?.exclusive,
          }),
        },
      ),
      /simulated death before config claim cleanup|rollback was incomplete/,
    );

    _setGlobalSetupCommitHookForTests(undefined);
    recoverGlobalSetupState(configPath, markerPath);
    assert.deepEqual(fs.readFileSync(configPath), oldConfig);
    assert.deepEqual(fs.readFileSync(markerPath), oldMarker);
    assert.equal(mode(configPath), 0o640);
    assert.equal(mode(markerPath), 0o604);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.onboarded', 'config.json']);
  } finally {
    _setGlobalSetupCommitHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global recovery retires coordinator-owned post-write claims without accumulating prior secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-post-write-crash-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  const priorSecret = 'prior-secret-must-not-survive';
  fs.writeFileSync(configPath, `${JSON.stringify({
    activeServer: 'brain',
    servers: {
      brain: { type: 'http', url: 'https://brain.example.test/mcp', apiKey: priorSecret },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markerPath, '', { mode: 0o600 });
  _setGlobalSetupCommitHookForTests((event) => {
    if (event.stage === 'after-write-replacement' && event.target === configPath) {
      throw new Error('simulated death after config replacement');
    }
  });

  const persistence: GlobalSetupPersistence = {
    configPath,
    markerPath,
    saveConfig: (config, options) => writeFileAtomic(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600, exclusive: options?.exclusive },
    ),
    writeMarker: (options) => writeFileAtomic(markerPath, '', {
      mode: 0o600,
      exclusive: options?.exclusive,
    }),
  };

  try {
    // Crossing the receipt limit proves each recovery retires the exact claim;
    // otherwise the 65th recovery fails closed before it can make progress.
    for (let iteration = 0; iteration < 65; iteration += 1) {
      assert.throws(
        () => persistGlobalSetupOrThrow({ activeServer: '', servers: {} }, persistence),
        /simulated death after config replacement|rollback was incomplete/,
      );
      recoverGlobalSetupState(configPath, markerPath);
      assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
        activeServer: '',
        servers: {},
      });
      assert.deepEqual(
        fs.readdirSync(root).sort(),
        ['.onboarded', 'config.json'],
        'the coordinator must retire both the claim and every recovery receipt',
      );
    }
    const remainingBytes = fs.readdirSync(root)
      .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
      .join('\n');
    assert.doesNotMatch(remainingBytes, new RegExp(priorSecret));
  } finally {
    _setGlobalSetupCommitHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous global claim is never auto-restored after its canonical partial disappears', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-ambiguous-claim-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"old":true}\n');
  fs.writeFileSync(markerPath, 'ready\n');
  _setGlobalSetupCommitHookForTests((event) => {
    if (event.stage === 'after-write-claim' && event.target === configPath) {
      throw new Error('simulated config interruption');
    }
  });

  try {
    assert.throws(() => persistGlobalSetupOrThrow(
      { activeServer: '', servers: {} },
      {
        configPath,
        markerPath,
        saveConfig: () => { throw new Error('not reached'); },
        writeMarker: () => { throw new Error('not reached'); },
      },
    ), /simulated config interruption|rollback was incomplete/);
    _setGlobalSetupCommitHookForTests(undefined);
    fs.writeFileSync(configPath, '{"partial":');
    recoverGlobalSetupState(configPath, markerPath);
    const claim = fs.readdirSync(root).find((name) => name.endsWith('.claim'));
    assert.ok(claim);
    fs.unlinkSync(configPath);
    recoverGlobalSetupState(configPath, markerPath);
    assert.equal(fs.existsSync(configPath), false, 'an ambiguous old claim must not be resurrected');
    assert.equal(fs.existsSync(path.join(root, claim)), true);
  } finally {
    _setGlobalSetupCommitHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global coordinator rolls config back after process death between config and marker commits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-coordinator-config-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  const oldConfig = '{"old":true}\n';
  const oldMarker = 'old-ready\n';
  fs.writeFileSync(configPath, oldConfig, { mode: 0o640 });
  fs.writeFileSync(markerPath, oldMarker, { mode: 0o604 });
  _setGlobalSetupTransactionHookForTests((event) => {
    if (event.stage === 'after-config-commit') throw new Error('simulated death between files');
  });

  try {
    assert.throws(() => persistGlobalSetupOrThrow(
      { activeServer: '', servers: {} },
      {
        configPath,
        markerPath,
        saveConfig: (config, options) => writeFileAtomic(
          configPath,
          `${JSON.stringify(config, null, 2)}\n`,
          { mode: 0o600, exclusive: options?.exclusive },
        ),
        writeMarker: (options) => writeFileAtomic(markerPath, '', {
          mode: 0o600,
          exclusive: options?.exclusive,
        }),
      },
    ), /simulated death between files/);
    assert.notEqual(fs.readFileSync(configPath, 'utf8'), oldConfig);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), oldMarker);

    _setGlobalSetupTransactionHookForTests(undefined);
    recoverGlobalSetupState(configPath, markerPath);
    assert.equal(fs.readFileSync(configPath, 'utf8'), oldConfig);
    assert.equal(mode(configPath), 0o640);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), oldMarker);
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.global-setup.')), false);
  } finally {
    _setGlobalSetupTransactionHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global coordinator completes a pair after process death following marker commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-global-coordinator-marker-'));
  const configPath = path.join(root, 'config.json');
  const markerPath = path.join(root, '.onboarded');
  fs.writeFileSync(configPath, '{"old":true}\n');
  fs.writeFileSync(markerPath, 'old-ready\n');
  _setGlobalSetupTransactionHookForTests((event) => {
    if (event.stage === 'after-marker-commit') throw new Error('simulated death after pair commit');
  });

  try {
    assert.throws(() => persistGlobalSetupOrThrow(
      { activeServer: '', servers: {} },
      {
        configPath,
        markerPath,
        saveConfig: (config, options) => writeFileAtomic(
          configPath,
          `${JSON.stringify(config, null, 2)}\n`,
          { mode: 0o600, exclusive: options?.exclusive },
        ),
        writeMarker: (options) => writeFileAtomic(markerPath, '', {
          mode: 0o600,
          exclusive: options?.exclusive,
        }),
      },
    ), /simulated death after pair commit/);
    const committedConfig = fs.readFileSync(configPath);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), '');

    _setGlobalSetupTransactionHookForTests(undefined);
    recoverGlobalSetupState(configPath, markerPath);
    assert.deepEqual(fs.readFileSync(configPath), committedConfig);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), '');
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.global-setup.')), false);
  } finally {
    _setGlobalSetupTransactionHookForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
