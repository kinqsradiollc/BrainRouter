import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionService, SessionService } from '../session/service.js';
import {
  readTranscriptEntries, readTranscriptTail, listTranscripts, loadTranscript, getTranscriptPath,
} from '../session/sessionStore.js';

test('SessionService is a per-workspace facade — delegates to the session store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'session-svc-'));
  const sk = 'sess-1';
  try {
    const svc = createSessionService(ws);
    assert.ok(svc instanceof SessionService);
    assert.equal(svc.exists(sk), false);

    svc.append(sk, { role: 'user', content: 'hi' });
    svc.append(sk, { role: 'assistant', content: 'hello' });
    assert.equal(svc.read(sk).length, 2);
    assert.deepEqual(svc.read(sk), readTranscriptEntries(ws, sk));
    assert.deepEqual(svc.readTail(sk), readTranscriptTail(ws, sk));
    assert.deepEqual(svc.load(sk), loadTranscript(ws, sk));

    assert.equal(svc.exists(sk), true);
    assert.ok(svc.sizeBytes(sk) > 0);
    assert.equal(svc.transcriptPath(sk), getTranscriptPath(ws, sk));
    assert.deepEqual(svc.list(), listTranscripts(ws));
    assert.ok(svc.list().length >= 1);

    const rewound = svc.rewind(sk, 1);
    assert.equal(typeof rewound.ok, 'boolean');
    assert.ok(Array.isArray(rewound.kept));

    assert.equal(svc.delete(sk), true);
    assert.equal(svc.exists(sk), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
