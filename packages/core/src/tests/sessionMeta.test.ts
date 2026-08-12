/**
 * Session metadata persistence regressions.
 *
 * Metadata is per exact session key, precedence is human-first, and concurrent
 * CLI/Desktop processes must serialize CAS and preserve unrelated rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  __setSessionMetaWriteHooksForTests,
  compareAndSetSessionTitle, setSessionMeta, setSessionTitle, getSessionMeta,
  removeSessionMeta, listSessionGroups, readSessionMetaAll,
} from '../session/state/sessionMetaStore.js';
import { appendTranscriptEntry, listTranscripts, deleteSession, forkSession, readTranscriptEntries } from '../session/transcript/sessionStore.js';
import { getStateFile } from '../storage/store.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('DESK-6m sessionMeta: set merges + prunes defaults; remove clears', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    setSessionMeta(ws, 'k:1', { pinned: true, title: 'My chat' });
    assert.deepEqual(getSessionMeta(ws, 'k:1'), { pinned: true, title: 'My chat' });
    // a merge that flips pinned off + sets completed; 'active' and false are pruned.
    setSessionMeta(ws, 'k:1', { pinned: false, status: 'completed' });
    assert.deepEqual(getSessionMeta(ws, 'k:1'), { title: 'My chat', status: 'completed' });
    setSessionMeta(ws, 'k:1', { status: 'active', title: '' }); // both prune away
    assert.deepEqual(getSessionMeta(ws, 'k:1'), {});
    assert.deepEqual(readSessionMetaAll(ws), {}, 'fully-default entry is dropped from the file');

    setSessionMeta(ws, 'k:2', { archived: true });
    removeSessionMeta(ws, 'k:2');
    assert.deepEqual(getSessionMeta(ws, 'k:2'), {});
  });
});

test('session title compare-and-set preserves human and hook precedence', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const empty = getSessionMeta(ws, 'title:1');
    assert.equal(compareAndSetSessionTitle(ws, 'title:1', empty, {
      title: 'Fix release verification', source: 'agent',
    }).updated, true);

    setSessionTitle(ws, 'title:1', 'Human release review', 'human');
    assert.equal(compareAndSetSessionTitle(ws, 'title:1', {
      title: 'Human release review', titleSource: 'human',
    }, { title: 'Agent replacement', source: 'agent' }).reason, 'precedence');
    assert.equal(getSessionMeta(ws, 'title:1').title, 'Human release review');

    const expected = getSessionMeta(ws, 'title:2');
    setSessionTitle(ws, 'title:2', 'Hook assigned title', 'hook');
    assert.equal(compareAndSetSessionTitle(ws, 'title:2', expected, {
      title: 'Late agent title', source: 'agent',
    }).reason, 'changed');
  });
});

test('session title authority is human over hook over agent over derived', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const empty = getSessionMeta(ws, 'title:priority');
    const derived = compareAndSetSessionTitle(ws, 'title:priority', empty, {
      title: 'Investigate release behavior', source: 'derived',
    });
    assert.equal(derived.updated, true);
    assert.deepEqual(derived.meta, {
      title: 'Investigate release behavior', titleSource: 'derived',
    });

    const agent = compareAndSetSessionTitle(ws, 'title:priority', derived.meta, {
      title: 'Verify release behavior', source: 'agent',
    });
    assert.equal(agent.updated, true);
    assert.equal(agent.meta.titleSource, 'agent');

    assert.deepEqual(setSessionTitle(ws, 'title:priority', 'Hook release title', 'hook'), {
      title: 'Hook release title', titleSource: 'hook',
    });
    assert.deepEqual(setSessionTitle(ws, 'title:priority', 'Human release title', 'human'), {
      title: 'Human release title', titleSource: 'human',
    });
    assert.deepEqual(setSessionTitle(ws, 'title:priority', 'Late hook title', 'hook'), {
      title: 'Human release title', titleSource: 'human',
    });
    assert.deepEqual(setSessionTitle(ws, 'title:priority', 'Late agent title', 'agent'), {
      title: 'Human release title', titleSource: 'human',
    });
  });
});

test('DESK-6m sessionMeta: listSessionGroups returns distinct, sorted groups', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    setSessionMeta(ws, 'a', { group: 'Work' });
    setSessionMeta(ws, 'b', { group: 'Personal' });
    setSessionMeta(ws, 'c', { group: 'Work' });
    setSessionMeta(ws, 'd', { pinned: true }); // ungrouped
    assert.deepEqual(listSessionGroups(ws), ['Personal', 'Work']);
  });
});

test('DESK-6m fork duplicates the transcript to a new key; delete removes it', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    appendTranscriptEntry(ws, 'chat:orig', { role: 'user', content: 'hello there' });
    appendTranscriptEntry(ws, 'chat:orig', { role: 'assistant', content: 'hi!' });

    const forkKey = forkSession(ws, 'chat:orig');
    assert.ok(forkKey && forkKey.startsWith('chat:fork-'), 'fork key under the same prefix');
    const forked = readTranscriptEntries(ws, forkKey!, 40);
    assert.equal(forked.length, 2, 'fork has a copy of the transcript');
    assert.equal((forked[0] as { content?: string }).content, 'hello there');

    // original untouched; deleting the fork leaves the original.
    assert.ok(listTranscripts(ws).some((s) => s.sessionKey === 'chat:orig'));
    assert.equal(deleteSession(ws, forkKey!), true);
    assert.ok(!listTranscripts(ws).some((s) => s.sessionKey === forkKey));
    assert.ok(listTranscripts(ws).some((s) => s.sessionKey === 'chat:orig'), 'original survives');
  });
});

test('concurrent CLI and Desktop metadata writers preserve every session row', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const workerCount = 8;
    const sessionsPerWorker = 8;
    const moduleUrl = new URL('../session/state/sessionMetaStore.js', import.meta.url).href;
    const tsxLoaderUrl = import.meta.resolve('tsx');
    const workers = Array.from({ length: workerCount }, (_, worker) => {
      const script = `
        import { setSessionMeta } from ${JSON.stringify(moduleUrl)};
        const workspace = process.argv[1];
        const worker = Number(process.argv[2]);
        const count = Number(process.argv[3]);
        for (let index = 0; index < count; index++) {
          setSessionMeta(workspace, \`writer-\${worker}:session-\${index}\`, {
            pinned: true,
            group: \`worker-\${worker}\`,
          });
        }
      `;
      return childExit(spawn(process.execPath, [
        '--import',
        tsxLoaderUrl,
        '--input-type=module',
        '--eval',
        script,
        ws,
        String(worker),
        String(sessionsPerWorker),
      ], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] }));
    });
    await Promise.all(workers);

    const all = readSessionMetaAll(ws);
    assert.equal(Object.keys(all).length, workerCount * sessionsPerWorker);
    for (let worker = 0; worker < workerCount; worker += 1) {
      for (let index = 0; index < sessionsPerWorker; index += 1) {
        assert.deepEqual(all[`writer-${worker}:session-${index}`], {
          pinned: true,
          group: `worker-${worker}`,
        });
      }
    }
  });
});

test('cross-process human title waits for an in-flight agent CAS and still wins', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const sessionKey = 'title:cross-process-race';
    const attempted = path.join(ws, 'human-title-attempted');
    const completed = path.join(ws, 'human-title-completed');
    const moduleUrl = new URL('../session/state/sessionMetaStore.js', import.meta.url).href;
    const tsxLoaderUrl = import.meta.resolve('tsx');
    let humanWorker: Promise<void> | undefined;

    __setSessionMetaWriteHooksForTests({
      beforeWrite: () => {
        const script = `
          import fs from 'node:fs';
          import { setSessionTitle } from ${JSON.stringify(moduleUrl)};
          fs.writeFileSync(process.argv[3], 'attempted');
          setSessionTitle(process.argv[1], process.argv[2], 'Human release title', 'human');
          fs.writeFileSync(process.argv[4], 'completed');
        `;
        const child = spawn(process.execPath, [
          '--import',
          tsxLoaderUrl,
          '--input-type=module',
          '--eval',
          script,
          ws,
          sessionKey,
          attempted,
          completed,
        ], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
        humanWorker = childExit(child);
        const deadline = Date.now() + 2_000;
        while (!fs.existsSync(attempted) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        assert.equal(fs.existsSync(attempted), true, 'human writer reached the metadata mutation');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        assert.equal(fs.existsSync(completed), false, 'the agent CAS still owns the cross-process lock');
      },
    });
    try {
      const expected = getSessionMeta(ws, sessionKey);
      assert.equal(compareAndSetSessionTitle(ws, sessionKey, expected, {
        title: 'Agent release title',
        source: 'agent',
      }).updated, true);
    } finally {
      __setSessionMetaWriteHooksForTests(undefined);
    }
    assert.ok(humanWorker, 'the CAS write hook started the human writer');
    await humanWorker;
    assert.deepEqual(getSessionMeta(ws, sessionKey), {
      title: 'Human release title',
      titleSource: 'human',
    });
  });
});

test('session metadata corruption and invalid schema fail closed without quarantine or overwrite', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    setSessionMeta(ws, 'preserved:session', { pinned: true, group: 'Release' });
    const file = getStateFile(ws, 'sessionMeta.json');
    const valid = fs.readFileSync(file, 'utf8');
    const invalidCases = [
      '{"preserved:session":',
      JSON.stringify({ 'preserved:session': { pinned: 'yes' } }),
      JSON.stringify({ 'preserved:session': { pinned: true, unknownField: true } }),
    ];
    for (const invalid of invalidCases) {
      fs.writeFileSync(file, invalid, { encoding: 'utf8', mode: 0o600 });
      assert.throws(() => readSessionMetaAll(ws), /corrupt|invalid schema|invalid pinned|unknown fields/i);
      assert.throws(
        () => setSessionMeta(ws, 'must:not:replace', { archived: true }),
        /corrupt|invalid schema|invalid pinned|unknown fields/i,
      );
      assert.equal(fs.readFileSync(file, 'utf8'), invalid);
      assert.equal(
        fs.readdirSync(path.dirname(file)).some((entry) => entry.startsWith('sessionMeta.json.corrupt-')),
        false,
      );
      fs.writeFileSync(file, valid, { encoding: 'utf8', mode: 0o600 });
    }
    assert.deepEqual(getSessionMeta(ws, 'preserved:session'), { pinned: true, group: 'Release' });
  });
});

test('session metadata treats __proto__ as an exact key without prototype mutation', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    setSessionMeta(ws, '__proto__', { title: 'Prototype session', pinned: true });
    setSessionMeta(ws, 'ordinary:session', { group: 'Safe' });

    const all = readSessionMetaAll(ws);
    assert.equal(Object.getPrototypeOf(all), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(all, '__proto__'), true);
    assert.deepEqual(getSessionMeta(ws, '__proto__'), {
      title: 'Prototype session',
      pinned: true,
    });
    assert.deepEqual(getSessionMeta(ws, 'ordinary:session'), { group: 'Safe' });

    removeSessionMeta(ws, '__proto__');
    assert.deepEqual(getSessionMeta(ws, '__proto__'), {});
    assert.deepEqual(getSessionMeta(ws, 'ordinary:session'), { group: 'Safe' });
  });
});

test('session metadata rejects a symlink store without changing its target', async () => {
  if (process.platform === 'win32') return;
  await withTempWorkspaceAsync(async (ws) => {
    const file = getStateFile(ws, 'sessionMeta.json');
    const sentinel = path.join(ws, 'session-meta-sentinel.json');
    const contents = '{"sentinel":true}\n';
    fs.writeFileSync(sentinel, contents, { encoding: 'utf8', mode: 0o600 });
    fs.symlinkSync(sentinel, file);

    assert.throws(() => readSessionMetaAll(ws), /unsafe or invalid session metadata store/i);
    assert.throws(
      () => setSessionMeta(ws, 'must:not:write', { pinned: true }),
      /unsafe or invalid session metadata store/i,
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), contents);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  });
});

function childExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Session metadata worker exited ${code}: ${stderr}`));
    });
  });
}
