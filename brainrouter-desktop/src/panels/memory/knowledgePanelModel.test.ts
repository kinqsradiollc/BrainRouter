import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KNOWLEDGE_UPLOAD_LIMITS,
  describeKnowledgeUpload,
  knowledgeTitleFromFileName,
} from './knowledgePanelModel.js';

test('knowledge upload model recognizes every supported source without a path', () => {
  assert.deepEqual(describeKnowledgeUpload('guide.md', 'text/markdown', 12), {
    sourceFormat: 'markdown',
    binary: false,
    maxBytes: KNOWLEDGE_UPLOAD_LIMITS.text,
  });
  assert.equal(describeKnowledgeUpload('guide.htm', '', 12).sourceFormat, 'html');
  assert.equal(describeKnowledgeUpload('guide.pdf', '', 12).binary, true);
  assert.equal(describeKnowledgeUpload('guide.docx', '', 12).maxBytes, KNOWLEDGE_UPLOAD_LIMITS.docx);
});

test('knowledge upload model rejects unsupported and oversized files', () => {
  assert.throws(() => describeKnowledgeUpload('archive.zip', 'application/zip', 12), /TXT, Markdown/);
  assert.throws(
    () => describeKnowledgeUpload('large.html', 'text/html', KNOWLEDGE_UPLOAD_LIMITS.html + 1),
    /1 MB or smaller/,
  );
  assert.throws(
    () => describeKnowledgeUpload('large.docx', '', KNOWLEDGE_UPLOAD_LIMITS.docx + 1),
    /4 MB or smaller/,
  );
});

test('knowledge upload title is bounded and derived from the browser filename only', () => {
  assert.equal(knowledgeTitleFromFileName('deployment.guide.md'), 'deployment.guide');
  assert.equal(knowledgeTitleFromFileName('.md'), '.md');
  assert.equal(knowledgeTitleFromFileName(`${'x'.repeat(600)}.txt`).length, 500);
});
