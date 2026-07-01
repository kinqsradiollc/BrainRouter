import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAttachmentService, AttachmentService } from '../attachment/service.js';
import { getAttachment, listAttachments, safeAttachmentName, attachmentDir, type CreateAttachmentInput } from '../attachment/attachmentStore.js';

test('AttachmentService is a per-workspace facade — delegates to the attachment store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-svc-'));
  try {
    const svc = createAttachmentService(ws);
    assert.ok(svc instanceof AttachmentService);
    assert.equal(svc.safeName('a b.png'), safeAttachmentName('a b.png'));

    const input: CreateAttachmentInput = {
      id: 'att1', name: 'doc.txt', kind: 'text', mimeType: 'text/plain',
      byteSize: 5, sha256: 'abc123', storedPath: '/tmp/doc.txt', sessionKey: 's1',
    };
    const a = svc.create(input);
    assert.equal(a.id, 'att1');
    assert.equal(svc.dir('att1'), attachmentDir(ws, 'att1'));
    assert.deepEqual(svc.get('att1'), getAttachment(ws, 'att1'));
    assert.deepEqual(svc.list(), listAttachments(ws));
    assert.equal(svc.list().length, 1);

    assert.equal(svc.update('att1', { extractedText: 'hello' })?.extractedText, 'hello');
    assert.ok(svc.linkMemory('att1', 'mem-1'));
    assert.equal(typeof svc.contextMarkdown(a), 'string');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
