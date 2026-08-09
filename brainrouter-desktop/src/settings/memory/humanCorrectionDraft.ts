/**
 * ADR-032 D1 — pure renderer view-model for the explicit correction form.
 *
 * This only prepares the three human-entered fields. It deliberately has no
 * identity, tenant, session, tier, or provenance fields; those are host-owned.
 */
export const HUMAN_CORRECTION_LIMITS = {
  statement: 400,
  falsifier: 1_000,
  expectation: 1_000,
} as const;

export interface HumanCorrectionDraft {
  statement: string;
  falsifier: string;
  expectation: string;
}

export interface HumanCorrectionDraftState {
  fields: HumanCorrectionDraft;
  ready: boolean;
  error?: string;
}

export function humanCorrectionDraftState(input: HumanCorrectionDraft): HumanCorrectionDraftState {
  const fields = {
    statement: input.statement.trim(),
    falsifier: input.falsifier.trim(),
    expectation: input.expectation.trim(),
  };
  for (const key of Object.keys(fields) as Array<keyof HumanCorrectionDraft>) {
    if (!fields[key]) return { fields, ready: false, error: `${key} is required` };
    if (fields[key].length > HUMAN_CORRECTION_LIMITS[key]) {
      return {
        fields,
        ready: false,
        error: `${key} must be at most ${HUMAN_CORRECTION_LIMITS[key]} characters`,
      };
    }
  }
  return { fields, ready: true };
}
