import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isAttachmentRecord } from '@kinqs/brainrouter-types';
import { ingestAttachment, attachmentContextMarkdown } from '../attachments/ingest.js';
import { getAttachment, listAttachments, linkAttachmentMemory } from '../state/attachmentStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('ingestAttachment: text file → record, preserved blob, extracted text, memory link', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const src = path.join(ws, 'notes.md');
    fs.writeFileSync(src, '# Title\n\nSome **markdown** content.\n');

    const rec = await ingestAttachment({
      workspaceRoot: ws,
      sessionKey: 'sess:a',
      source: { kind: 'path', path: src },
    });

    assert.ok(isAttachmentRecord(rec));
    assert.match(rec.id, /^att_[0-9a-f]{8}$/);
    assert.equal(rec.kind, 'text');
    assert.equal(rec.name, 'notes.md');
    assert.equal(rec.sessionKey, 'sess:a');
    assert.ok(rec.extractedText?.includes('markdown'));
    assert.equal(rec.sha256.length, 64);

    // Original blob preserved on disk and byte-identical.
    assert.ok(fs.existsSync(rec.storedPath), 'stored blob exists');
    assert.equal(fs.readFileSync(rec.storedPath, 'utf8'), fs.readFileSync(src, 'utf8'));

    // Durable: a fresh read returns the same record.
    assert.deepEqual(getAttachment(ws, rec.id), rec);
    assert.equal(listAttachments(ws, { sessionKey: 'sess:a' }).length, 1);

    // Memory link round-trips.
    const linked = linkAttachmentMemory(ws, rec.id, 'mem_x');
    assert.deepEqual(linked?.linkedMemoryIds, ['mem_x']);

    // Context markdown includes the file name + extracted body.
    const md = attachmentContextMarkdown(rec);
    assert.ok(md.includes('notes.md'));
    assert.ok(md.includes('markdown'));
  });
});

test('ingestAttachment: PNG bytes → image kind, dimensions, no text', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    // Minimal valid PNG signature + IHDR with width=3 height=7.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]), // IHDR length
      Buffer.from('IHDR'),
      Buffer.from([0x00, 0x00, 0x00, 0x03]), // width 3
      Buffer.from([0x00, 0x00, 0x00, 0x07]), // height 7
      Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]), // bit depth/color/etc
    ]);
    const rec = await ingestAttachment({
      workspaceRoot: ws,
      sessionKey: 's',
      source: { kind: 'bytes', name: 'shot.png', data: png },
    });
    assert.equal(rec.kind, 'image');
    assert.equal(rec.mimeType, 'image/png');
    assert.equal(rec.width, 3);
    assert.equal(rec.height, 7);
    assert.equal(rec.extractedText, undefined);
    assert.ok(fs.existsSync(rec.storedPath));
  });
});

test('ingestAttachment: rejects a directory path without throwing the process', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    await assert.rejects(
      ingestAttachment({ workspaceRoot: ws, sessionKey: 's', source: { kind: 'path', path: ws } }),
      /Not a file/,
    );
  });
});
