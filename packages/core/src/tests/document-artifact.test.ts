/**
 * ADR-030 D5/Q4 — the document lands somewhere, and the rest is reachable.
 *
 * §6 says the ADR is judged on a document with a scanned appendix saying it has
 * one rather than answering from nothing. These tests are the other half of
 * that: once it HAS been read, the part that did not fit in the turn has to be
 * addressable, and the turn has to say so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildDocumentArtifact, documentArtifactPath, parseDocumentPartId, readDocumentArtifact,
  splitDocumentParts, writeDocumentArtifact, DOCUMENT_ARTIFACT_LIMITS,
} from '../attachment/document/artifact.js';
import type { DocumentPageKind, ParsedDocument } from '../attachment/document/types.js';
import { ingestAttachment, attachmentContextMarkdown } from '../attachment/ingest/ingest.js';
import { deleteAttachment } from '../attachment/store/attachmentStore.js';
import { buildLocalWorkspaceRegistry, localWorkspaceViewer } from '../workspace/participants/localModes.js';
import { fenceWorkspaceResolutions } from '../workspace/participants/agentContext.js';
import { withTempWorkspaceAsync } from './_helpers.js';
import { pageOfProse, xrefPagesPdf } from './_pdfFixtures.js';

const NO_KINDS = new Map<number, DocumentPageKind>();

function parsed(markdown: string, over: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    classification: 'text',
    pages: [],
    markdown,
    truncated: false,
    notice: '',
    structureNote: '',
    limits: [],
    diagnostics: { textFrom: 'structured', classifiedBy: 'structured', elapsedMs: 1 },
    ...over,
  };
}

test('Q4: a part IS a page when the parse named one, and carries the page\'s kind', () => {
  const markdown = [
    '<!-- Page 1 -->', '', 'The first page.', '',
    '<!-- Page 2 -->', '', 'The second page.', '',
    '<!-- Page 3 -->', '', '',
  ].join('\n');
  const kinds = new Map<number, DocumentPageKind>([[1, 'text'], [2, 'text'], [3, 'scanned']]);
  const { parts } = splitDocumentParts(markdown, kinds);

  assert.equal(parts.length, 2, 'a page with nothing on it contributes no part');
  assert.deepEqual(parts.map((p) => [p.index, p.page]), [[1, 1], [2, 2]]);
  assert.equal(parts[0]!.kind, 'text');
  assert.ok(parts[0]!.text.includes('The first page.'));
  assert.ok(!parts[0]!.text.includes('Page 1 -->'), 'the marker is consumed, not left in the text');
});

test('Q4: without page markers a part claims no page number rather than a guessed one', () => {
  const paragraph = `${'x'.repeat(400)}\n`;
  const markdown = Array.from({ length: 40 }, () => paragraph).join('\n');
  const { parts } = splitDocumentParts(markdown, NO_KINDS);

  assert.ok(parts.length > 1, 'the baseline\'s text is still chunked into parts');
  for (const part of parts) {
    assert.equal(part.page, undefined, 'a part the parse could not place says so by omission');
    assert.equal(part.kind, undefined);
  }
});

test('D4: the artifact is bounded, and what it dropped is counted rather than hidden', () => {
  const pages: string[] = [];
  for (let i = 1; i <= DOCUMENT_ARTIFACT_LIMITS.maxParts + 25; i++) {
    pages.push(`<!-- Page ${i} -->`, `page ${i} body`, '');
  }
  const { parts, omitted } = splitDocumentParts(pages.join('\n'), NO_KINDS);
  assert.equal(parts.length, DOCUMENT_ARTIFACT_LIMITS.maxParts);
  assert.equal(omitted, 25, 'the parts past the cap are counted, not silently absent');

  // One enormous page cannot become the whole artifact.
  const huge = `<!-- Page 1 -->\n${'y'.repeat(DOCUMENT_ARTIFACT_LIMITS.maxPartChars * 3)}`;
  const one = splitDocumentParts(huge, NO_KINDS);
  assert.equal(one.parts[0]!.text.length, DOCUMENT_ARTIFACT_LIMITS.maxPartChars);
  assert.equal(one.parts[0]!.truncated, true);
});

test('the split is linear in the input — 100k adversarial lines, one pass', () => {
  // Every line looks like the start of a marker without being one, which is the
  // shape that makes a backtracking matcher quadratic.
  const hostile = Array.from({ length: 100_000 }, () => '<!-- Page 12345678901234567890 --').join('\n');
  const started = Date.now();
  const { parts } = splitDocumentParts(hostile, NO_KINDS);
  const elapsed = Date.now() - started;
  assert.ok(parts.length >= 1);
  assert.ok(elapsed < 2_000, `100k hostile lines took ${elapsed}ms`);
});

test('a part reference that is not one is refused at the parse, before any lookup', () => {
  assert.deepEqual(parseDocumentPartId('att_1234/7'), { attachmentId: 'att_1234', part: 7 });
  for (const bad of [
    'att_1234', 'att_1234/', '/7', 'att_1234/0', 'att_1234/007', 'att_1234/-1', 'att_1234/1.5',
    '../../etc/passwd/1', 'att_1234/../../1', 'att 1234/1', 'att_1234/99999999',
  ]) {
    assert.equal(parseDocumentPartId(bad), null, `${bad} is not a part reference`);
  }
});

test('the stored artifact round-trips, and a file this version did not write is treated as absent', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const artifact = buildDocumentArtifact({
      attachmentId: 'att_abc123',
      name: 'report.pdf',
      parsed: parsed('<!-- Page 1 -->\nhello'),
    });
    assert.equal(writeDocumentArtifact(ws, artifact), true);
    assert.equal(readDocumentArtifact(ws, 'att_abc123')?.parts[0]?.text, 'hello');

    const file = documentArtifactPath(ws, 'att_abc123')!;
    fs.writeFileSync(file, JSON.stringify({ version: 99, attachmentId: 'att_abc123', parts: [] }));
    assert.equal(readDocumentArtifact(ws, 'att_abc123'), null, 'a future shape is absent, not guessed at');
    fs.writeFileSync(file, 'not json at all');
    assert.equal(readDocumentArtifact(ws, 'att_abc123'), null);

    // An id that could be a path never becomes one.
    assert.equal(documentArtifactPath(ws, '../../etc'), null);
    assert.equal(readDocumentArtifact(ws, '../../etc'), null);
  });
});

test('D5 end to end: an attached PDF becomes an artifact the address space can resolve', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const rec = await ingestAttachment({
      workspaceRoot: ws,
      sessionKey: 's',
      source: {
        kind: 'bytes',
        name: 'paper.pdf',
        data: xrefPagesPdf([
          { lines: pageOfProse('Method', 30) },
          { lines: pageOfProse('Results', 30) },
          { image: true },
        ]),
      },
    });

    assert.equal(rec.documentRef, `brainrouter://document/outline/${rec.id}`);
    const artifact = readDocumentArtifact(ws, rec.id);
    assert.ok(artifact, 'the whole document was written beside the bytes');
    assert.ok(artifact.parts.length >= 2, 'with parts to address');

    const registry = buildLocalWorkspaceRegistry({ workspaceRoot: ws });
    const viewer = localWorkspaceViewer({ workspaceRoot: ws });

    const outline = await registry.resolveUri(rec.documentRef!, viewer);
    assert.equal(outline.status, 'found');
    const outlineText = fenceWorkspaceResolutions([outline])!;
    assert.ok(outlineText.includes('addressable part'), 'the outline says what its parts are');
    assert.ok(
      outlineText.includes(`brainrouter://document/part/${rec.id}/1`),
      'and gives each one an address',
    );
    assert.ok(!outlineText.includes('Method line 20'), 'the outline is a list, never the document');

    const part = await registry.resolveUri(`brainrouter://document/part/${rec.id}/2`, viewer);
    assert.equal(part.status, 'found');
    const partText = fenceWorkspaceResolutions([part])!;
    assert.ok(partText.includes('Results line'), 'a part resolves to its own text');
    assert.ok(partText.includes('<workspace_data>'), 'fenced as untrusted, like every other resolution');

    // A part that does not exist is a different sentence from a document that
    // does not exist, and both are tombstones rather than silence.
    const missing = await registry.resolveUri(`brainrouter://document/part/${rec.id}/9999`, viewer);
    assert.equal(missing.status, 'gone');
    const unknown = await registry.resolveUri('brainrouter://document/outline/att_nope', viewer);
    assert.equal(unknown.status, 'gone');
  });
});

test('Q4: a truncated extract states that more exists and how to ask for it', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const rec = await ingestAttachment({
      workspaceRoot: ws,
      sessionKey: 's',
      source: {
        kind: 'bytes',
        name: 'long.pdf',
        data: xrefPagesPdf([{ lines: pageOfProse('Body', 40) }, { lines: pageOfProse('More', 40) }]),
      },
    });

    const md = attachmentContextMarkdown(rec, { maxChars: 600 });
    assert.ok(md.includes('Only the first 600 characters'), `expected the count, got: ${md.slice(-400)}`);
    assert.ok(md.includes(`brainrouter://document/outline/${rec.id}`), 'and the reference to the rest');
    assert.ok(md.includes('document/part/'), 'and how to ask for one part');
    assert.ok(!md.includes('_(text truncated)_'), 'the old sentence said what was cut and nothing else');
  });
});

test('D3 survives into the artifact: a scanned page is a scanned PART', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const rec = await ingestAttachment({
      workspaceRoot: ws,
      sessionKey: 's',
      source: {
        kind: 'bytes',
        name: 'mixed.pdf',
        data: xrefPagesPdf([{ lines: pageOfProse('Report', 30) }, { image: true }]),
      },
    });
    const artifact = readDocumentArtifact(ws, rec.id);
    assert.ok(artifact);
    assert.match(artifact.notice, /page/i);
    // The scanned page contributes no text, so the parts that exist are the
    // readable ones — and the outline's notice is what says the other page is
    // there at all. An artifact that quietly listed 1 part for a 2-page document
    // with no sentence would be the failure this ADR is about.
    assert.ok(artifact.parts.every((part) => part.kind !== 'scanned' || part.text.length === 0));
  });
});

test('the artifact goes with the attachment — a parsed document cannot outlive its file', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const rec = await ingestAttachment({
      workspaceRoot: ws,
      sessionKey: 's',
      source: { kind: 'bytes', name: 'gone.pdf', data: xrefPagesPdf([{ lines: pageOfProse('Body', 20) }]) },
    });
    assert.ok(readDocumentArtifact(ws, rec.id), 'it was written');

    assert.equal(deleteAttachment(ws, rec.id), true);
    assert.equal(readDocumentArtifact(ws, rec.id), null, 'and it went with the blob, not on its own schedule');
  });
});

test('an attachment with no parsed document resolves as one, and never as an empty one', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const rec = await ingestAttachment({
      workspaceRoot: ws,
      sessionKey: 's',
      source: { kind: 'bytes', name: 'notes.txt', data: Buffer.from('plain text, not a document') },
    });
    assert.equal(rec.documentRef, undefined, 'nothing is cited that was not stored');

    const registry = buildLocalWorkspaceRegistry({ workspaceRoot: ws });
    const viewer = localWorkspaceViewer({ workspaceRoot: ws });
    const outline = await registry.resolveUri(`brainrouter://document/outline/${rec.id}`, viewer);
    assert.equal(outline.status, 'gone');
    assert.match(fenceWorkspaceResolutions([outline])!, /no parsed document/);
    assert.equal(
      fs.existsSync(documentArtifactPath(ws, rec.id)!), false,
      'and asking created nothing on disk',
    );
  });
});
