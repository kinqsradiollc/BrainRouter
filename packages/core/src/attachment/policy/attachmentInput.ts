/**
 * ADR-027 D4/D4.1 (P2-3) — turning an attachment into model input.
 *
 * This is the join between three things built separately: the attachment store
 * knows what a file IS, the modality capability knows what a model can RECEIVE,
 * and the degradation ladder knows what to do when those disagree. Without this
 * the agent has attachments it cannot use and a capability nothing consults.
 *
 * The rule the whole of D4.1 rests on: an attachment is NEVER silently dropped.
 * Each one becomes a multimodal part, or extracted text, or an explicit note
 * that it could not be included — and the note goes into the turn where the
 * model and the reader both see it. The failure being designed against is not a
 * rejected request; it is an agent answering confidently about a document it
 * never received, with nothing indicating the gap.
 */

import {
  modelAcceptsModality,
  type ModelCapabilities,
  type ModelInputModality,
} from '@kinqs/brainrouter-types';

/** The subset of an attachment record this needs. */
export interface AttachmentForInput {
  id: string;
  name: string;
  kind: 'pdf' | 'image' | 'text' | 'code' | 'file';
  mimeType: string;
  byteSize: number;
  /** Extracted text, when extraction succeeded. */
  extractedText?: string;
  textTruncated?: boolean;
  /** Raw bytes, base64. Required to send an image as a multimodal part. */
  dataBase64?: string;
}

export type AttachmentPart =
  /** A real multimodal image part the model will actually see. */
  | { kind: 'image'; attachmentId: string; name: string; mediaType: string; dataBase64: string }
  /** Text the model reads. `truncated` must be surfaced, not hidden. */
  | { kind: 'text'; attachmentId: string; name: string; text: string; truncated: boolean }
  /**
   * Could not be included. `reason` is shown to BOTH the model and the reader:
   * the model must not reason as though it saw the content, and the human must
   * know why their file had no effect.
   */
  | { kind: 'unavailable'; attachmentId: string; name: string; reason: string };

/** Which non-text modality an attachment needs from the model, if any. */
export function requiredModality(attachment: AttachmentForInput): ModelInputModality | null {
  if (attachment.kind === 'image') return 'image';
  // A PDF only needs native document support when we have no extracted text to
  // fall back on. Text is the cheaper path and works on every model.
  if (attachment.kind === 'pdf' && !attachment.extractedText) return 'pdf';
  return null;
}

export interface ResolveInput {
  attachments: readonly AttachmentForInput[];
  capabilities: Pick<ModelCapabilities, 'input'> | null | undefined;
}

export interface ResolvedAttachments {
  parts: readonly AttachmentPart[];
  /** True when anything was downgraded or dropped — the caller must tell the user. */
  degraded: boolean;
}

/**
 * Resolve every attachment against what the model can actually receive.
 *
 * `unknown` support is treated as ATTEMPT, not refuse. Declining to send an
 * image to an unannotated model would disable vision on every model an
 * operator never classified; attempting it and surfacing the uncertainty is the
 * only option that neither breaks nor deceives. The composer warns separately
 * (see the degradation ladder) — this layer's job is to never fabricate.
 */
export function resolveAttachmentsForModel(input: ResolveInput): ResolvedAttachments {
  const parts: AttachmentPart[] = [];
  let degraded = false;

  for (const attachment of input.attachments) {
    const modality = requiredModality(attachment);

    if (modality === null) {
      // Text-bearing. Extraction may still have failed, and that is not silent.
      if (attachment.extractedText) {
        parts.push({
          kind: 'text',
          attachmentId: attachment.id,
          name: attachment.name,
          text: attachment.extractedText,
          truncated: attachment.textTruncated === true,
        });
        if (attachment.textTruncated) degraded = true;
      } else {
        parts.push({
          kind: 'unavailable',
          attachmentId: attachment.id,
          name: attachment.name,
          reason: `No text could be extracted from this ${attachment.kind} file.`,
        });
        degraded = true;
      }
      continue;
    }

    const verdict = modelAcceptsModality(input.capabilities, modality);

    if (verdict === 'unsupported') {
      // A PDF with text already fell into the branch above, so reaching here
      // means there is no fallback to offer.
      parts.push({
        kind: 'unavailable',
        attachmentId: attachment.id,
        name: attachment.name,
        reason: `The selected model cannot read ${modality} input, and no text could be extracted.`,
      });
      degraded = true;
      continue;
    }

    if (modality === 'image') {
      if (!attachment.dataBase64) {
        // Declared an image but carries no bytes — a broken record, reported
        // rather than quietly omitted.
        parts.push({
          kind: 'unavailable',
          attachmentId: attachment.id,
          name: attachment.name,
          reason: 'The image data for this attachment is unavailable.',
        });
        degraded = true;
        continue;
      }
      parts.push({
        kind: 'image',
        attachmentId: attachment.id,
        name: attachment.name,
        mediaType: attachment.mimeType,
        dataBase64: attachment.dataBase64,
      });
      continue;
    }

    // Native document input, accepted or unverified. Nothing else to convert.
    parts.push({
      kind: 'unavailable',
      attachmentId: attachment.id,
      name: attachment.name,
      reason: 'Native document input is not yet wired for this model.',
    });
    degraded = true;
  }

  return { parts, degraded };
}

/**
 * The note that goes INTO the turn for anything unavailable.
 *
 * Returns null when everything was included. This text is not a UI nicety: a
 * model that is not told an attachment is missing will answer as though it read
 * it, which is the exact failure D4.1 exists to prevent.
 */
export function unavailableNotice(resolved: ResolvedAttachments): string | null {
  const missing = resolved.parts.filter((part): part is Extract<AttachmentPart, { kind: 'unavailable' }> =>
    part.kind === 'unavailable');
  if (missing.length === 0) return null;
  const lines = missing.map((part) => `- ${part.name}: ${part.reason}`);
  return [
    'The following attachment(s) could NOT be provided to you. Do not answer as though you have seen them; '
    + 'say plainly that they were unavailable if the question depends on them.',
    ...lines,
  ].join('\n');
}
