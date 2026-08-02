/**
 * ADR-027 D4/D4.1 (P2-3) — turning attachments into model input.
 *
 * One invariant runs through every test: an attachment is NEVER silently
 * dropped. It becomes a part, or text, or an explicit note the MODEL sees —
 * because a model not told an attachment is missing will answer as though it
 * read it, which is the failure D4.1 exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAttachmentsForModel,
  requiredModality,
  unavailableNotice,
  type AttachmentForInput,
} from '../attachment/policy/attachmentInput.js';

const image = (over: Partial<AttachmentForInput> = {}): AttachmentForInput => ({
  id: 'att_img', name: 'screenshot.png', kind: 'image', mimeType: 'image/png',
  byteSize: 100, dataBase64: 'AAAA', ...over,
});
const pdf = (over: Partial<AttachmentForInput> = {}): AttachmentForInput => ({
  id: 'att_pdf', name: 'spec.pdf', kind: 'pdf', mimeType: 'application/pdf',
  byteSize: 100, extractedText: 'the spec text', ...over,
});
const textFile = (over: Partial<AttachmentForInput> = {}): AttachmentForInput => ({
  id: 'att_txt', name: 'notes.md', kind: 'text', mimeType: 'text/markdown',
  byteSize: 10, extractedText: 'some notes', ...over,
});

const vision = { input: { status: 'known', accepts: ['image'] } } as const;
const textOnly = { input: { status: 'known', accepts: [] } } as const;
const unknown = { input: { status: 'unknown' } } as const;

test('a PDF with extracted text needs nothing special from the model', () => {
  // Text is the cheaper path and works everywhere; native document support is
  // only required when there is no text to fall back on.
  assert.equal(requiredModality(pdf()), null);
  assert.equal(requiredModality(pdf({ extractedText: undefined })), 'pdf');
  assert.equal(requiredModality(image()), 'image');
  assert.equal(requiredModality(textFile()), null);
});

test('an image reaches a vision model as a real multimodal part', () => {
  const { parts, degraded } = resolveAttachmentsForModel({
    attachments: [image()], capabilities: vision,
  });
  assert.equal(degraded, false);
  assert.deepEqual(parts, [{
    kind: 'image', attachmentId: 'att_img', name: 'screenshot.png',
    mediaType: 'image/png', dataBase64: 'AAAA',
  }]);
});

test('an image at a text-only model becomes an explicit note, not a silent drop', () => {
  const resolved = resolveAttachmentsForModel({ attachments: [image()], capabilities: textOnly });
  assert.equal(resolved.degraded, true);
  assert.equal(resolved.parts[0]!.kind, 'unavailable');

  const notice = unavailableNotice(resolved)!;
  assert.match(notice, /screenshot\.png/);
  assert.match(notice, /Do not answer as though you have seen them/,
    'the MODEL must be told, not just the user');
});

test('unknown support attempts rather than refuses', () => {
  // Declining would disable vision on every model an operator never annotated.
  // Attempting and surfacing the uncertainty is the only option that neither
  // breaks nor deceives.
  const resolved = resolveAttachmentsForModel({ attachments: [image()], capabilities: unknown });
  assert.equal(resolved.parts[0]!.kind, 'image');
  assert.equal(resolved.degraded, false);
});

test('a PDF is sent as text regardless of the model\'s image support', () => {
  for (const capabilities of [vision, textOnly, unknown]) {
    const { parts } = resolveAttachmentsForModel({ attachments: [pdf()], capabilities });
    assert.equal(parts[0]!.kind, 'text');
  }
});

test('truncated extraction is reported, not passed off as complete', () => {
  const resolved = resolveAttachmentsForModel({
    attachments: [pdf({ textTruncated: true })], capabilities: textOnly,
  });
  assert.equal(resolved.degraded, true, 'the caller must be able to say the text was cut');
  const part = resolved.parts[0]!;
  assert.equal(part.kind, 'text');
  assert.equal((part as { truncated: boolean }).truncated, true);
});

test('a text file with no extracted text is reported', () => {
  const resolved = resolveAttachmentsForModel({
    attachments: [textFile({ extractedText: undefined })], capabilities: textOnly,
  });
  assert.equal(resolved.parts[0]!.kind, 'unavailable');
  assert.match(unavailableNotice(resolved)!, /No text could be extracted/);
});

test('an image record carrying no bytes is reported, not omitted', () => {
  // A broken record. Quietly skipping it is how a user believes their
  // screenshot was read.
  const resolved = resolveAttachmentsForModel({
    attachments: [image({ dataBase64: undefined })], capabilities: vision,
  });
  assert.equal(resolved.parts[0]!.kind, 'unavailable');
  assert.match(unavailableNotice(resolved)!, /image data for this attachment is unavailable/);
});

test('a text-less PDF at a model without document support is reported', () => {
  const resolved = resolveAttachmentsForModel({
    attachments: [pdf({ extractedText: undefined })], capabilities: textOnly,
  });
  assert.equal(resolved.parts[0]!.kind, 'unavailable');
  assert.match(unavailableNotice(resolved)!, /cannot read pdf input/);
});

test('every attachment yields exactly one part — nothing vanishes', () => {
  const attachments = [
    image(), pdf(), textFile(),
    image({ id: 'broken', dataBase64: undefined }),
    textFile({ id: 'empty', extractedText: undefined }),
  ];
  const { parts } = resolveAttachmentsForModel({ attachments, capabilities: vision });
  assert.equal(parts.length, attachments.length);
  assert.deepEqual(
    parts.map((p) => p.attachmentId).sort(),
    attachments.map((a) => a.id).sort(),
  );
});

test('a fully-included set produces no notice', () => {
  const resolved = resolveAttachmentsForModel({
    attachments: [image(), pdf()], capabilities: vision,
  });
  assert.equal(resolved.degraded, false);
  assert.equal(unavailableNotice(resolved), null, 'no noise when nothing is missing');
});

test('no attachments is a clean empty result', () => {
  const resolved = resolveAttachmentsForModel({ attachments: [], capabilities: vision });
  assert.deepEqual(resolved.parts, []);
  assert.equal(resolved.degraded, false);
  assert.equal(unavailableNotice(resolved), null);
});
