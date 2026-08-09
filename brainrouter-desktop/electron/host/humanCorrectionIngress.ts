/**
 * ADR-032 D1/D8 — authenticated Desktop ingress for human corrections.
 *
 * The renderer may provide ONLY the correction, falsifier, and expected
 * outcome. Identity, tenant, and session provenance are read from host-owned
 * state immediately before the synchronous recorder runs. This module stays
 * behind a narrow injected port so neither chat prose nor a model-callable
 * tool can reach the instruction tier.
 */
import type { LearnedItem, LearnedTenant } from '@kinqs/brainrouter-core/learning';

export const HUMAN_CORRECTION_FIELD_LIMITS = {
  statement: 400,
  falsifier: 400,
  expectation: 400,
} as const;

export interface HumanCorrectionFields {
  statement: string;
  falsifier: string;
  expectation: string;
}

export interface HumanCorrectionRecordInput extends HumanCorrectionFields {
  tenant: LearnedTenant;
  sessionKey: string;
}

export type HumanCorrectionRecordResult =
  | { admitted: true; item: LearnedItem }
  | { admitted: false; rule: string; reason: string };

export type HumanCorrectionRecorder = (
  input: HumanCorrectionRecordInput,
) => HumanCorrectionRecordResult;

export interface AuthenticatedCorrectionBinding {
  authenticated: boolean;
  accountUserId: unknown;
  accountOrgId: unknown;
  tenant: LearnedTenant;
  sessionKey: unknown;
  bindingError?: string | null;
}

export interface HumanCorrectionAvailability {
  allowed: boolean;
  reason?: string;
}

export interface HumanCorrectionIngress {
  availability: () => HumanCorrectionAvailability;
  record: (args: Record<string, unknown>) => HumanCorrectionRecordResult;
}

type HumanCorrectionIngressDeps = {
  readBinding: () => AuthenticatedCorrectionBinding;
  record: HumanCorrectionRecorder;
};

function normalizedRequiredId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function bindingAvailability(binding: AuthenticatedCorrectionBinding): HumanCorrectionAvailability {
  if (binding.bindingError) return { allowed: false, reason: binding.bindingError };
  if (!binding.authenticated) {
    return { allowed: false, reason: 'Sign in before recording a human correction.' };
  }
  const accountUserId = normalizedRequiredId(binding.accountUserId);
  const accountOrgId = normalizedRequiredId(binding.accountOrgId);
  const sessionKey = normalizedRequiredId(binding.sessionKey);
  if (!accountUserId || !accountOrgId) {
    return { allowed: false, reason: 'Select an authenticated account and organization before recording a correction.' };
  }
  if (!sessionKey) {
    return { allowed: false, reason: 'Open an active chat before recording a correction.' };
  }
  const tenantUserId = normalizedRequiredId(binding.tenant.userId);
  const tenantOrgId = normalizedRequiredId(binding.tenant.orgId);
  if (tenantUserId !== accountUserId || tenantOrgId !== accountOrgId) {
    return { allowed: false, reason: 'The active chat is still bound to a different account or organization.' };
  }
  return { allowed: true };
}

function readFields(args: Record<string, unknown>): HumanCorrectionFields | HumanCorrectionRecordResult {
  const values = {
    statement: typeof args.statement === 'string' ? args.statement.trim() : '',
    falsifier: typeof args.falsifier === 'string' ? args.falsifier.trim() : '',
    expectation: typeof args.expectation === 'string' ? args.expectation.trim() : '',
  };
  for (const key of Object.keys(values) as Array<keyof HumanCorrectionFields>) {
    if (!values[key]) {
      return { admitted: false, rule: 'malformed', reason: `${key} is required` };
    }
    if (values[key].length > HUMAN_CORRECTION_FIELD_LIMITS[key]) {
      return {
        admitted: false,
        rule: 'malformed',
        reason: `${key} must be at most ${HUMAN_CORRECTION_FIELD_LIMITS[key]} characters`,
      };
    }
  }
  return values;
}

export function createAuthenticatedHumanCorrectionIngress(
  deps: HumanCorrectionIngressDeps,
): HumanCorrectionIngress {
  return {
    availability: () => bindingAvailability(deps.readBinding()),
    record: (args) => {
      const binding = deps.readBinding();
      const availability = bindingAvailability(binding);
      if (!availability.allowed) {
        return { admitted: false, rule: 'unauthorized', reason: availability.reason ?? 'Correction unavailable.' };
      }
      const fields = readFields(args);
      if ('admitted' in fields) return fields;
      return deps.record({
        tenant: {
          userId: normalizedRequiredId(binding.accountUserId),
          orgId: normalizedRequiredId(binding.accountOrgId),
        },
        sessionKey: normalizedRequiredId(binding.sessionKey),
        ...fields,
      });
    },
  };
}
