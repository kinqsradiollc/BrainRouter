import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPromptBase, buildPromptWithAttachments, readyAttachments } from './attachmentPrompt.js';
import type { AttachmentUpload } from '../../types.js';

const upload = (overrides: Partial<AttachmentUpload>): AttachmentUpload => ({
  id: 'u1',
  name: 'report.md',
  size: 12,
  status: 'attached',
  attachmentId: 'att_1',
  ...overrides,
});

test('readyAttachments keeps only attached records with durable ids', () => {
  assert.deepEqual(readyAttachments([
    upload({ id: 'ready', attachmentId: 'att_ready' }),
    upload({ id: 'missing-id', attachmentId: undefined }),
    upload({ id: 'pending', status: 'attaching', attachmentId: 'att_pending' }),
    upload({ id: 'failed', status: 'failed', attachmentId: 'att_failed' }),
  ]).map((a) => a.id), ['ready']);
});

test('attachmentPromptBase supplies a useful prompt for attachment-only sends', () => {
  assert.equal(attachmentPromptBase('', 1), 'Please use the attached file as context.');
  assert.equal(attachmentPromptBase('  ', 2), 'Please use the attached files as context.');
  assert.equal(attachmentPromptBase('Summarize this', 1), 'Summarize this');
});

test('buildPromptWithAttachments appends compact attachment context', () => {
  const prompt = buildPromptWithAttachments('Summarize this', [
    upload({ contextMarkdown: '### Attachment: report.md\n- id: att_1\n\n```text```' }),
  ]);
  assert.match(prompt, /^Summarize this\n\nAttached file context:/);
  assert.match(prompt, /#### File 1/);
  assert.match(prompt, /### Attachment: report\.md/);
});

test('buildPromptWithAttachments falls back to id and kind when context is absent', () => {
  const prompt = buildPromptWithAttachments('', [
    upload({ name: 'image.png', kind: 'image', contextMarkdown: undefined }),
  ]);
  assert.match(prompt, /^Please use the attached file as context\./);
  assert.match(prompt, /### Attachment: image\.png/);
  assert.match(prompt, /- id: att_1/);
  assert.match(prompt, /- kind: image/);
});
