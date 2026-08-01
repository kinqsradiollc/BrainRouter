/**
 * ADR-027 D4.1 (P2-6) — what to do when a turn carries input the selected model
 * may not accept.
 *
 * One pure function, shared by every surface, because the failure this prevents
 * is a *silent* one. Left to each caller, "the model probably handles it" gets
 * decided differently in the composer, the router, and the agent tool path, and
 * the one that guesses wrong produces an agent answering confidently about a
 * picture it never received.
 *
 * The ladder, in order:
 *
 *   1. The model accepts everything present  -> send.
 *   2. Something is known-unsupported, but another enabled model accepts it
 *      -> reroute this turn. The router already supports per-turn selection.
 *   3. Something is known-unsupported and nothing else accepts it -> BLOCK, and
 *      say so at attach time rather than at send time. Learning that an image
 *      cannot be read is far more useful before the prompt is written.
 *   4. Support is unknown -> send, but SURFACE the uncertainty. Blocking here
 *      would break every model an operator never annotated; silently sending is
 *      the status quo that loses the image. Telling the human is the only
 *      option that neither breaks nor deceives.
 */

import {
  modelAcceptsModality,
  type ModelCapabilities,
  type ModelInputModality,
} from '@kinqs/brainrouter-types';

/** A model the turn could be routed to instead. */
export interface ModalityCandidate {
  id: string;
  label?: string;
  capabilities: Pick<ModelCapabilities, 'input'>;
}

export type ModalityPlan =
  /** Every attached modality is accepted by the selected model. */
  | { action: 'send' }
  /**
   * The selected model cannot take something attached, but another enabled
   * model can. `modality` is what forced the move — useful for the notice.
   */
  | { action: 'reroute'; to: string; label?: string; modality: ModelInputModality }
  /**
   * Known-unsupported with no alternative. The caller must refuse the
   * attachment at ATTACH time; sending would produce an answer about content
   * the model never saw.
   */
  | { action: 'block'; unsupported: readonly ModelInputModality[] }
  /**
   * Nobody has told us whether this model accepts these. Proceed, but the
   * caller MUST show the uncertainty — an unverified image is exactly the
   * "confident answer, invisible missing input" case.
   */
  | { action: 'send-unverified'; unverified: readonly ModelInputModality[] };

export interface ModalityPlanInput {
  /** Non-text inputs the turn carries. Empty means an ordinary text turn. */
  attached: readonly ModelInputModality[];
  /** Capabilities of the model the user selected. */
  selected: Pick<ModelCapabilities, 'input'> | null | undefined;
  /**
   * Other models the caller may route to. Omit (or pass empty) where rerouting
   * is not available — the plan then blocks instead of moving.
   */
  candidates?: readonly ModalityCandidate[];
}

/**
 * Decide how to handle a turn's non-text inputs.
 *
 * Known-unsupported outranks unknown: if a turn carries both an image the model
 * definitely cannot read and a PDF nobody has classified, the definite problem
 * is the one to act on. Reporting only the uncertainty would bury it.
 */
export function planForModalities(input: ModalityPlanInput): ModalityPlan {
  const attached = [...new Set(input.attached)];
  if (attached.length === 0) return { action: 'send' };

  const unsupported: ModelInputModality[] = [];
  const unverified: ModelInputModality[] = [];
  for (const modality of attached) {
    const verdict = modelAcceptsModality(input.selected, modality);
    if (verdict === 'unsupported') unsupported.push(modality);
    else if (verdict === 'unknown') unverified.push(modality);
  }

  if (unsupported.length > 0) {
    // Prefer a candidate that accepts EVERY attached modality — moving to a
    // model that fixes one problem and introduces another is not progress.
    const rescue = (input.candidates ?? []).find((candidate) =>
      attached.every((modality) => modelAcceptsModality(candidate.capabilities, modality) === 'accepted'));
    if (rescue) {
      return {
        action: 'reroute',
        to: rescue.id,
        ...(rescue.label ? { label: rescue.label } : {}),
        modality: unsupported[0]!,
      };
    }
    return { action: 'block', unsupported };
  }

  if (unverified.length > 0) return { action: 'send-unverified', unverified };
  return { action: 'send' };
}

/**
 * Human-facing sentence for a plan. Centralised so the wording of a
 * consequential message does not drift between the composer and the CLI.
 */
export function describeModalityPlan(plan: ModalityPlan): string | null {
  switch (plan.action) {
    case 'send':
      return null;
    case 'reroute':
      return `This model cannot read ${plan.modality} input, so this turn will use `
        + `${plan.label ?? plan.to} instead.`;
    case 'block':
      return `The selected model cannot read ${plan.unsupported.join(' or ')} input, and no `
        + 'available model can. Remove the attachment or choose a different model — sending it '
        + 'would produce an answer about content the model never saw.';
    case 'send-unverified':
      return `It is not recorded whether this model can read ${plan.unverified.join(' or ')} `
        + 'input. Sending anyway; if the reply ignores the attachment, that is why.';
  }
}
