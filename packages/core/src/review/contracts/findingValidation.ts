/**
 * Runtime validation for evidence-bound assurance findings.
 *
 * A verifier disposition is only authoritative when it matches the finding
 * state and cites evidence pinned to the same exact repository revision.
 */

import {
  ASSURANCE_COVERAGE_STATES,
  ASSURANCE_EVIDENCE_KINDS,
  ASSURANCE_FINDING_STATES,
  ASSURANCE_SEVERITIES,
  REPOSITORY_ASSURANCE_PROGRAMS,
} from '@kinqs/brainrouter-types/review';
import type { AssuranceValidationResult } from './assuranceValidation.js';
import {
  checkForbiddenSecretKeys,
  checkString,
  oneOf,
  record,
} from './validationHelpers.js';

/** Validate one untrusted finding before a host persists or publishes it. */
export function validateAssuranceFinding(value: unknown): AssuranceValidationResult {
  const issues: string[] = [];
  const finding = record(value);
  if (!finding) return { ok: false, issues: ['finding must be an object'] };
  checkForbiddenSecretKeys(finding, issues, 'finding');

  checkString(finding, 'id', 'finding', issues);
  checkString(finding, 'fingerprint', 'finding', issues);
  if (!oneOf(finding.program, REPOSITORY_ASSURANCE_PROGRAMS)) issues.push('finding.program is invalid');
  checkString(finding, 'revisionSha', 'finding', issues);
  if (!oneOf(finding.state, ASSURANCE_FINDING_STATES)) issues.push('finding.state is invalid');
  if (!oneOf(finding.severity, ASSURANCE_SEVERITIES)) issues.push('finding.severity is invalid');
  if (
    typeof finding.confidence !== 'number'
    || !Number.isFinite(finding.confidence)
    || finding.confidence < 0
    || finding.confidence > 1
  ) {
    issues.push('finding.confidence must be between 0 and 1');
  }
  checkString(finding, 'title', 'finding', issues);
  checkString(finding, 'mechanism', 'finding', issues);
  checkString(finding, 'createdAt', 'finding', issues);
  checkString(finding, 'updatedAt', 'finding', issues);

  const location = record(finding.location);
  if (!location) {
    issues.push('finding.location must be an object');
  } else {
    checkString(location, 'path', 'finding.location', issues);
    for (const key of ['line', 'endLine']) {
      if (location[key] !== undefined && (!Number.isInteger(location[key]) || Number(location[key]) < 1)) {
        issues.push(`finding.location.${key} must be a positive integer`);
      }
    }
  }

  const evidenceIds = new Set<string>();
  if (!Array.isArray(finding.evidence)) {
    issues.push('finding.evidence must be an array');
  } else {
    finding.evidence.forEach((raw, index) => {
      const evidence = record(raw);
      if (!evidence) {
        issues.push(`finding.evidence[${index}] must be an object`);
        return;
      }
      checkString(evidence, 'id', `finding.evidence[${index}]`, issues);
      if (typeof evidence.id === 'string') {
        if (evidenceIds.has(evidence.id)) issues.push(`finding.evidence[${index}].id is duplicated`);
        evidenceIds.add(evidence.id);
      }
      if (!oneOf(evidence.kind, ASSURANCE_EVIDENCE_KINDS)) {
        issues.push(`finding.evidence[${index}].kind is invalid`);
      }
      checkString(evidence, 'summary', `finding.evidence[${index}]`, issues);
      checkString(evidence, 'revisionSha', `finding.evidence[${index}]`, issues);
      checkString(evidence, 'createdAt', `finding.evidence[${index}]`, issues);
      if (evidence.revisionSha !== finding.revisionSha) {
        issues.push(`finding.evidence[${index}].revisionSha must match finding.revisionSha`);
      }
    });
  }

  if (!Array.isArray(finding.provenance)) {
    issues.push('finding.provenance must be an array');
  } else {
    finding.provenance.forEach((raw, index) => {
      const provenance = record(raw);
      if (!provenance) {
        issues.push(`finding.provenance[${index}] must be an object`);
        return;
      }
      if (!oneOf(provenance.producerKind, ['deterministic_analyzer', 'model', 'human', 'runtime_probe'])) {
        issues.push(`finding.provenance[${index}].producerKind is invalid`);
      }
      checkString(provenance, 'producerId', `finding.provenance[${index}]`, issues);
      checkString(provenance, 'policyHash', `finding.provenance[${index}]`, issues);
      checkString(provenance, 'createdAt', `finding.provenance[${index}]`, issues);
    });
  }

  if (!Array.isArray(finding.coverageLimitations)) {
    issues.push('finding.coverageLimitations must be an array');
  } else {
    finding.coverageLimitations.forEach((raw, index) => {
      const limitation = record(raw);
      if (!limitation) {
        issues.push(`finding.coverageLimitations[${index}] must be an object`);
        return;
      }
      checkString(limitation, 'id', `finding.coverageLimitations[${index}]`, issues);
      checkString(limitation, 'component', `finding.coverageLimitations[${index}]`, issues);
      if (!oneOf(limitation.state, ASSURANCE_COVERAGE_STATES) || limitation.state === 'covered') {
        issues.push(`finding.coverageLimitations[${index}].state must describe a limitation`);
      }
      checkString(limitation, 'reasonCode', `finding.coverageLimitations[${index}]`, issues);
      checkString(limitation, 'summary', `finding.coverageLimitations[${index}]`, issues);
    });
  }

  const verifier = finding.verifier === undefined ? null : record(finding.verifier);
  if (finding.verifier !== undefined && !verifier) {
    issues.push('finding.verifier must be an object');
  } else if (verifier) {
    if (!oneOf(verifier.state, ASSURANCE_FINDING_STATES)
      || verifier.state === 'candidate'
      || verifier.state === 'hotspot') {
      issues.push('finding.verifier.state is invalid');
    }
    if (verifier.state !== finding.state) issues.push('finding.verifier.state must match finding.state');
    checkString(verifier, 'verifierId', 'finding.verifier', issues);
    checkString(verifier, 'rationale', 'finding.verifier', issues);
    checkString(verifier, 'decidedAt', 'finding.verifier', issues);
    if (!Array.isArray(verifier.evidenceRefs) || verifier.evidenceRefs.length === 0) {
      issues.push('finding.verifier.evidenceRefs must be a non-empty array');
    } else if (!verifier.evidenceRefs.every((id) => typeof id === 'string' && evidenceIds.has(id))) {
      issues.push('finding.verifier.evidenceRefs must reference persisted finding evidence');
    }
  }
  if (
    (finding.state === 'verified' || finding.state === 'validated' || finding.state === 'disputed')
    && !verifier
  ) {
    issues.push(`finding.state ${String(finding.state)} requires a verifier disposition`);
  }
  if ((finding.state === 'candidate' || finding.state === 'hotspot') && verifier) {
    issues.push(`finding.state ${String(finding.state)} cannot have a verifier disposition`);
  }

  return { ok: issues.length === 0, issues };
}
