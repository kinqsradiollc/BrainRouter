import type {
  AssuranceImpactPacketAssembly,
  AssurancePolicySnapshot,
  RepositoryRevision,
} from '@kinqs/brainrouter-types/review';

export interface ImpactPacketValidationResult {
  ok: boolean;
  issues: string[];
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Validate the host-produced packet boundary before deterministic or model
 * consumers receive it. This is intentionally independent of an index/parser
 * implementation.
 */
export function validateAssuranceImpactPacketAssembly(
  assembly: AssuranceImpactPacketAssembly,
  revision: RepositoryRevision,
  policy: AssurancePolicySnapshot,
): ImpactPacketValidationResult {
  const issues: string[] = [];
  if (assembly.revisionSha !== revision.headSha) {
    issues.push('Impact packet assembly revision must match the run head revision.');
  }
  if (!assembly.indexRef.trim()) {
    issues.push('Impact packet assembly requires an opaque index reference.');
  }
  if (
    !positiveInteger(policy.packetLimits.maxPackets) ||
    !positiveInteger(policy.packetLimits.maxPacketBytes) ||
    !positiveInteger(policy.packetLimits.maxFilesPerPacket)
  ) {
    issues.push('Impact packet policy limits must be positive integers.');
  }
  if (assembly.packets.length > policy.packetLimits.maxPackets) {
    issues.push('Impact packet assembly exceeds the policy packet-count limit.');
  }

  const packetIds = new Set<string>();
  for (const packet of assembly.packets) {
    if (packetIds.has(packet.id)) {
      issues.push(`Impact packet id ${packet.id} is duplicated.`);
    }
    packetIds.add(packet.id);
    if (packet.revisionSha !== revision.headSha) {
      issues.push(`Impact packet ${packet.id} does not match the run head revision.`);
    }
    if (packet.program !== policy.program) {
      issues.push(`Impact packet ${packet.id} does not match the assurance program.`);
    }
    if (packet.changed.length === 0) {
      issues.push(`Impact packet ${packet.id} requires at least one changed source anchor.`);
    }
    if (packet.byteCount < 0 || !Number.isInteger(packet.byteCount)) {
      issues.push(`Impact packet ${packet.id} has an invalid byte count.`);
    } else if (packet.byteCount > policy.packetLimits.maxPacketBytes) {
      issues.push(`Impact packet ${packet.id} exceeds the policy byte limit.`);
    }
    const paths = new Set([
      ...packet.changed.map((location) => location.path),
      ...packet.context.map((entry) => entry.evidence.location?.path).filter((path): path is string => Boolean(path)),
      ...packet.sourceToSinkPaths.flatMap((path) => [path.source.path, path.sink.path]),
    ]);
    if (paths.size > policy.packetLimits.maxFilesPerPacket) {
      issues.push(`Impact packet ${packet.id} exceeds the policy file limit.`);
    }
    if (packet.truncated && packet.limitationIds.length === 0) {
      issues.push(`Truncated impact packet ${packet.id} requires a coverage limitation.`);
    }
    for (const context of packet.context) {
      if (!Number.isInteger(context.distance) || context.distance < 0) {
        issues.push(`Impact packet ${packet.id} contains an invalid graph distance.`);
      }
      if (context.evidence.revisionSha !== revision.headSha) {
        issues.push(`Impact packet ${packet.id} contains stale context evidence.`);
      }
    }
    for (const path of packet.sourceToSinkPaths) {
      if (path.evidenceRefs.length < 2) {
        issues.push(`Impact packet ${packet.id} source-to-sink path ${path.id} lacks path evidence.`);
      }
    }
  }

  const limitationIds = new Set(assembly.limitations.map((limitation) => limitation.id));
  for (const packet of assembly.packets) {
    for (const limitationId of packet.limitationIds) {
      if (!limitationIds.has(limitationId)) {
        issues.push(`Impact packet ${packet.id} references unknown limitation ${limitationId}.`);
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
