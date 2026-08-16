/**
 * ADR-034 — recipient-side trust decision for inbound session messages.
 *
 * The carrying transport is irrelevant. Auto-application is safe only when
 * every effective mutation surface is either unavailable or guaranteed to ask
 * a human again. Unknown capability is deliberately treated as potentially
 * mutable and therefore held.
 */

export type MutationAuthority = 'denied' | 'confirm' | 'allow' | 'unknown';

export interface SessionMessageRecipientAuthority {
  workspaceFiles?: MutationAuthority;
  shell?: MutationAuthority;
  computerUse?: MutationAuthority;
  externalWrites?: MutationAuthority;
  remoteTools?: MutationAuthority;
}

export interface SessionMessageApprovalAssessment {
  hold: boolean;
  reason: string;
  unsafeSurfaces: Array<keyof SessionMessageRecipientAuthority>;
}

const MUTATION_SURFACES: ReadonlyArray<keyof SessionMessageRecipientAuthority> = [
  'workspaceFiles',
  'shell',
  'computerUse',
  'externalWrites',
  'remoteTools',
];

/** Pure, fail-closed recipient hold predicate. */
export function assessSessionMessageApproval(
  authority: SessionMessageRecipientAuthority,
): SessionMessageApprovalAssessment {
  const unsafeSurfaces = MUTATION_SURFACES.filter((surface) => {
    const disposition = authority[surface] ?? 'unknown';
    return disposition === 'allow' || disposition === 'unknown';
  });
  if (unsafeSurfaces.length > 0) {
    return {
      hold: true,
      unsafeSurfaces,
      reason: `Recipient can mutate without a guaranteed human confirmation on: ${unsafeSurfaces.join(', ')}.`,
    };
  }
  return {
    hold: false,
    unsafeSurfaces: [],
    reason: 'Every effective mutation surface is denied or requires another human confirmation.',
  };
}

export function shouldHoldSessionMessage(
  authority: SessionMessageRecipientAuthority,
): boolean {
  return assessSessionMessageApproval(authority).hold;
}
