/**
 * C3 — pure renderer model for safe Project-knowledge uploads.
 *
 * File selection stays in browser code and produces content/base64 only. The
 * host never receives a local path, and both sides enforce the same byte caps
 * before the backend applies its authoritative parser limits.
 */
export const KNOWLEDGE_UPLOAD_LIMITS = {
  text: 2 * 1024 * 1024,
  html: 1 * 1024 * 1024,
  pdf: 2 * 1024 * 1024,
  docx: 4 * 1024 * 1024,
} as const;

export type KnowledgeUploadFormat = 'text' | 'markdown' | 'html' | 'pdf' | 'docx';

export interface KnowledgeUploadDescriptor {
  sourceFormat: KnowledgeUploadFormat;
  binary: boolean;
  maxBytes: number;
}

export function describeKnowledgeUpload(
  fileName: string,
  mimeType: string,
  byteSize: number,
): KnowledgeUploadDescriptor {
  const name = fileName.trim();
  if (!name || name.length > 500) throw new Error('Choose a file whose name is 500 characters or fewer.');
  const lower = name.toLowerCase();
  let descriptor: KnowledgeUploadDescriptor;
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') {
    descriptor = { sourceFormat: 'pdf', binary: true, maxBytes: KNOWLEDGE_UPLOAD_LIMITS.pdf };
  } else if (
    lower.endsWith('.docx')
    || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    descriptor = { sourceFormat: 'docx', binary: true, maxBytes: KNOWLEDGE_UPLOAD_LIMITS.docx };
  } else if (lower.endsWith('.html') || lower.endsWith('.htm') || mimeType === 'text/html') {
    descriptor = { sourceFormat: 'html', binary: false, maxBytes: KNOWLEDGE_UPLOAD_LIMITS.html };
  } else if (
    lower.endsWith('.md')
    || lower.endsWith('.markdown')
    || mimeType === 'text/markdown'
  ) {
    descriptor = { sourceFormat: 'markdown', binary: false, maxBytes: KNOWLEDGE_UPLOAD_LIMITS.text };
  } else if (lower.endsWith('.txt') || !mimeType || mimeType === 'text/plain') {
    descriptor = { sourceFormat: 'text', binary: false, maxBytes: KNOWLEDGE_UPLOAD_LIMITS.text };
  } else {
    throw new Error('Choose a TXT, Markdown, HTML, PDF, or DOCX file.');
  }
  if (!Number.isFinite(byteSize) || byteSize < 0 || byteSize > descriptor.maxBytes) {
    const mb = descriptor.maxBytes / 1024 / 1024;
    throw new Error(`${descriptor.sourceFormat.toUpperCase()} files must be ${mb} MB or smaller.`);
  }
  return descriptor;
}

export function knowledgeTitleFromFileName(fileName: string): string {
  const title = fileName.replace(/\.[^.]+$/, '').trim();
  return (title || fileName).slice(0, 500);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
