import type { AttachmentUpload } from '../../types.js';

export function readyAttachments(attachments: AttachmentUpload[]): AttachmentUpload[] {
  return attachments.filter((a) => a.status === 'attached' && !!a.attachmentId);
}

export function attachmentPromptBase(typedPrompt: string, readyCount: number): string {
  const prompt = typedPrompt.trim();
  if (prompt) return prompt;
  return readyCount === 1
    ? 'Please use the attached file as context.'
    : 'Please use the attached files as context.';
}

export function buildPromptWithAttachments(typedPrompt: string, attachments: AttachmentUpload[]): string {
  const ready = readyAttachments(attachments);
  const prompt = attachmentPromptBase(typedPrompt, ready.length);
  if (ready.length === 0) return prompt;
  const blocks = ready.map((a, index) => {
    const fallback = [
      `### Attachment: ${a.name}`,
      `- id: ${a.attachmentId}`,
      a.kind ? `- kind: ${a.kind}` : '',
    ].filter(Boolean).join('\n');
    return `#### File ${index + 1}\n${a.contextMarkdown?.trim() || fallback}`;
  });
  return `${prompt}\n\nAttached file context:\n${blocks.join('\n\n')}`;
}
