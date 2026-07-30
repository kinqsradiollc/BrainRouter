import { createHash } from 'node:crypto';
import type {
  AssembleAssuranceImpactPacketsInput,
  AssuranceCoverageLimitation,
  AssuranceEvidenceKind,
  AssuranceEvidenceRef,
  AssuranceImpactContext,
  AssuranceImpactPacket,
  AssuranceImpactPacketAssembly,
  AssuranceSourceLocation,
  AssuranceSourceToSinkPath,
} from '@kinqs/brainrouter-types/review';
import type { AssuranceOperationCancellation, RepositoryAssuranceImpactPort } from '@kinqs/brainrouter-core/review';
import type { CheckoutIndexResolver, ParserBackedIndexResolver } from '../index/graphTypes.js';
import { selectImpactGraph, type SecurityBoundaryClassifier, type SelectedImpactContext } from './graphTraversal.js';

const DEFAULT_MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const SNIPPET_CONTEXT_LINES = 4;
const SNIPPET_MAX_LINES = 80;

export interface ImpactPacketArtifact {
  ref: string;
  revisionSha: string;
  path: string;
  content: string;
  byteCount: number;
}

export interface ImpactPacketRedactionInput {
  policyId: string;
  path: string;
  content: string;
}

export interface ImpactPacketAssemblerOptions {
  indexes: ParserBackedIndexResolver;
  checkouts: CheckoutIndexResolver;
  redact(input: ImpactPacketRedactionInput): string | Promise<string>;
  classifySecurityBoundary?: SecurityBoundaryClassifier;
  maxSourceFileBytes?: number;
  now?: () => string;
}

export class ImpactPacketAssemblyCanceledError extends Error {
  constructor() {
    super('Repository impact packet assembly was canceled.');
    this.name = 'ImpactPacketAssemblyCanceledError';
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function evidenceKind(relationship: SelectedImpactContext['relationship']): AssuranceEvidenceKind {
  if (relationship === 'caller' || relationship === 'callee' || relationship === 'source_to_sink') {
    return 'call_path';
  }
  if (relationship === 'configuration') return 'configuration';
  if (relationship === 'dependency') return 'dependency';
  if (relationship === 'test') return 'test';
  return 'reference_path';
}

function evidenceSummary(context: SelectedImpactContext): string {
  const label = context.symbol.location.logicalPath ?? context.symbol.name;
  return `${context.relationship} context at ${label}`;
}

function limitation(
  id: string,
  reasonCode: string,
  summary: string,
  affectedPaths: string[] = [],
): AssuranceCoverageLimitation {
  return {
    id,
    component: 'impact-packet-assembly',
    state: 'partial',
    reasonCode,
    summary,
    ...(affectedPaths.length ? { affectedPaths: affectedPaths.slice(0, 100) } : {}),
  };
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { value, truncated: false };
  let end = Math.max(0, maxBytes);
  let bounded = bytes.subarray(0, end).toString('utf8');
  while (end > 0 && Buffer.byteLength(bounded) > maxBytes) {
    end -= 1;
    bounded = bytes.subarray(0, end).toString('utf8');
  }
  return {
    value: bounded,
    truncated: true,
  };
}

function snippet(source: string, locations: AssuranceSourceLocation[]): string {
  const lines = source.split(/\r?\n/);
  const lineNumbers = locations.flatMap((location) => [location.line ?? 1, location.endLine ?? location.line ?? 1]);
  const first = Math.max(1, Math.min(...lineNumbers) - SNIPPET_CONTEXT_LINES);
  const last = Math.min(
    lines.length,
    Math.min(Math.max(...lineNumbers) + SNIPPET_CONTEXT_LINES, first + SNIPPET_MAX_LINES - 1),
  );
  return lines
    .slice(first - 1, last)
    .map((line, index) => `${String(first + index).padStart(5, ' ')} | ${line}`)
    .join('\n');
}

async function canceled(cancellation: AssuranceOperationCancellation | undefined): Promise<boolean> {
  return Boolean(await cancellation?.isCancellationRequested());
}

function dedupeLocations(locations: AssuranceSourceLocation[]): AssuranceSourceLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line ?? 0}:${location.endLine ?? 0}:${location.symbol ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isEligibleInventoryPath(path: string, eligiblePaths: Set<string>): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..')
    && eligiblePaths.has(path);
}

export class DeterministicImpactPacketAssembler implements RepositoryAssuranceImpactPort {
  private readonly maxSourceFileBytes: number;
  private readonly now: () => string;
  private readonly artifacts = new Map<string, ImpactPacketArtifact>();

  constructor(private readonly options: ImpactPacketAssemblerOptions) {
    this.maxSourceFileBytes = options.maxSourceFileBytes ?? DEFAULT_MAX_SOURCE_FILE_BYTES;
    if (!Number.isInteger(this.maxSourceFileBytes) || this.maxSourceFileBytes < 1) {
      throw new Error('Impact packet source-file limit must be a positive integer.');
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  resolveArtifact(ref: string): ImpactPacketArtifact | null {
    const artifact = this.artifacts.get(ref);
    return artifact ? { ...artifact } : null;
  }

  releaseArtifacts(refs: Iterable<string>): void {
    for (const ref of refs) this.artifacts.delete(ref);
  }

  async assemble(
    input: AssembleAssuranceImpactPacketsInput,
    cancellation?: AssuranceOperationCancellation,
  ): Promise<AssuranceImpactPacketAssembly> {
    if (await canceled(cancellation)) throw new ImpactPacketAssemblyCanceledError();
    if (!input.changed.length) throw new Error('Impact packet assembly requires changed source anchors.');
    if (!input.redactionPolicyId.trim()) {
      throw new Error('Impact packet assembly requires a redaction policy.');
    }
    if (
      !Number.isInteger(input.limits.maxPackets) ||
      input.limits.maxPackets < 1 ||
      !Number.isInteger(input.limits.maxPacketBytes) ||
      input.limits.maxPacketBytes < 1 ||
      !Number.isInteger(input.limits.maxFilesPerPacket) ||
      input.limits.maxFilesPerPacket < 1
    ) {
      throw new Error('Impact packet limits must be positive integers.');
    }
    const index = this.options.indexes.resolve(input.indexRef);
    const checkout = this.options.checkouts.resolve(input.checkoutRef);
    if (!index || !checkout) {
      throw new Error('Exact checkout and parser index are required for impact packet assembly.');
    }
    if (index.revisionSha !== input.revision.headSha || checkout.revisionSha !== input.revision.headSha) {
      throw new Error('Impact packet inputs must match the run head revision.');
    }
    const eligiblePaths = new Set(checkout.eligiblePaths);
    if (input.changed.some((location) => !isEligibleInventoryPath(location.path, eligiblePaths))) {
      throw new Error('Impact packet changed paths must belong to the exact source inventory.');
    }

    const assemblyLimitations: AssuranceCoverageLimitation[] = [];
    const sortedChanges = [...input.changed].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        (left.line ?? 0) - (right.line ?? 0) ||
        (left.symbol ?? '').localeCompare(right.symbol ?? ''),
    );
    const selectedChanges = sortedChanges.slice(0, input.limits.maxPackets);
    if (input.changed.length > selectedChanges.length) {
      assemblyLimitations.push(
        limitation(
          'impact-packet-count-limit',
          'IMPACT_PACKET_COUNT_LIMIT',
          `Only ${selectedChanges.length} of ${input.changed.length} changed anchors received packets.`,
          sortedChanges.slice(selectedChanges.length).map((location) => location.path),
        ),
      );
    }

    const packets: AssuranceImpactPacket[] = [];
    const createdArtifacts: ImpactPacketArtifact[] = [];
    for (const changed of selectedChanges) {
      if (await canceled(cancellation)) throw new ImpactPacketAssemblyCanceledError();
      const selection = selectImpactGraph(index, [changed], {
        classifySecurityBoundary: this.options.classifySecurityBoundary,
      });
      const packetKey = `${input.revision.headSha}:${input.program}:${changed.path}:${changed.line ?? 0}:${changed.symbol ?? ''}`;
      const packetId = stableId('impact-packet', packetKey);
      const packetLimitations: AssuranceCoverageLimitation[] = [];
      if (!selection.changedSymbols.length) {
        packetLimitations.push(
          limitation(
            `${packetId}:unmatched-change`,
            'IMPACT_CHANGED_ANCHOR_UNMATCHED',
            'The parser index could not map this changed anchor to a symbol.',
            [changed.path],
          ),
        );
      }
      if (selection.contextTruncated) {
        packetLimitations.push(
          limitation(
            `${packetId}:graph-context-limit`,
            'IMPACT_GRAPH_CONTEXT_LIMIT',
            'Graph traversal reached the bounded context-selection limit.',
          ),
        );
      }
      if (selection.securityPathsTruncated) {
        packetLimitations.push(
          limitation(
            `${packetId}:security-path-limit`,
            'IMPACT_SECURITY_PATH_LIMIT',
            'Source-to-sink path discovery reached the bounded path limit.',
          ),
        );
      }

      const context = selection.context.map((item) => this.contextEvidence(input.revision.headSha, item));
      const contextByEvidenceId = new Map(context.map((item) => [item.evidence.id, item]));
      const sourceToSinkPaths: AssuranceSourceToSinkPath[] = [];
      for (const path of selection.securityPaths) {
        const evidenceRefs: string[] = [];
        let currentSymbolId = path.source.id;
        for (let position = 0; position < path.edges.length; position += 1) {
          const edge = path.edges[position];
          const nextSymbolId = edge.fromSymbolId === currentSymbolId ? edge.toSymbolId : edge.fromSymbolId;
          const toSymbol = index.symbols.find((symbol) => symbol.id === nextSymbolId);
          if (!toSymbol) continue;
          const selected: SelectedImpactContext = {
            symbol: toSymbol,
            edge,
            relationship: 'source_to_sink',
            distance: position + 1,
          };
          const evidenceContext = this.contextEvidence(input.revision.headSha, selected);
          evidenceRefs.push(evidenceContext.evidence.id);
          contextByEvidenceId.set(evidenceContext.evidence.id, evidenceContext);
          currentSymbolId = nextSymbolId;
        }
        if (evidenceRefs.length < 2) continue;
        sourceToSinkPaths.push({
          id: stableId('source-sink-path', evidenceRefs.join(':')),
          mechanism: 'call_path',
          source: { ...path.source.location },
          sink: { ...path.sink.location },
          evidenceRefs,
        });
      }

      const orderedContext = [...contextByEvidenceId.values()];
      const locations = dedupeLocations([
        changed,
        ...orderedContext
          .map((item) => item.evidence.location)
          .filter((location): location is AssuranceSourceLocation => Boolean(location)),
        ...sourceToSinkPaths.flatMap((path) => [path.source, path.sink]),
      ]);
      const artifactResult = await this.buildArtifacts(
        input,
        packetId,
        locations,
        eligiblePaths,
        cancellation,
      );
      packetLimitations.push(...artifactResult.limitations);
      createdArtifacts.push(...artifactResult.artifacts);
      const includedContext = orderedContext.filter(
        (item) => !item.evidence.location || artifactResult.includedPaths.has(item.evidence.location.path),
      );
      const includedEvidenceIds = new Set(includedContext.map((item) => item.evidence.id));
      const includedSecurityPaths = sourceToSinkPaths.filter(
        (path) =>
          artifactResult.includedPaths.has(path.source.path) &&
          artifactResult.includedPaths.has(path.sink.path) &&
          path.evidenceRefs.every((ref) => includedEvidenceIds.has(ref)),
      );
      const omittedContext = orderedContext.length - includedContext.length;
      if (omittedContext > 0) {
        packetLimitations.push(
          limitation(
            `${packetId}:context-limit`,
            'IMPACT_CONTEXT_LIMIT',
            `${omittedContext} graph context records were omitted by packet limits.`,
          ),
        );
      }

      const uniqueLimitations = [...new Map(packetLimitations.map((item) => [item.id, item])).values()];
      assemblyLimitations.push(...uniqueLimitations);
      packets.push({
        id: packetId,
        revisionSha: input.revision.headSha,
        program: input.program,
        changed: [changed],
        context: includedContext,
        sourceToSinkPaths: includedSecurityPaths,
        artifactRefs: artifactResult.artifacts.map((artifact) => artifact.ref),
        byteCount: artifactResult.artifacts.reduce((total, artifact) => total + artifact.byteCount, 0),
        truncated: uniqueLimitations.length > 0,
        limitationIds: uniqueLimitations.map((item) => item.id),
      });
    }

    for (const artifact of createdArtifacts) this.artifacts.set(artifact.ref, artifact);
    return {
      revisionSha: input.revision.headSha,
      indexRef: input.indexRef,
      packets,
      limitations: [...new Map(assemblyLimitations.map((item) => [item.id, item])).values()],
      assembledAt: this.now(),
    };
  }

  private contextEvidence(revisionSha: string, selected: SelectedImpactContext): AssuranceImpactContext {
    const evidence: AssuranceEvidenceRef = {
      id: stableId(
        'impact-evidence',
        `${revisionSha}:${selected.relationship}:${selected.edge.id}:${selected.symbol.id}`,
      ),
      kind: evidenceKind(selected.relationship),
      summary: evidenceSummary(selected),
      revisionSha,
      location: { ...selected.symbol.location },
      analyzerId: 'typescript-parser-index',
      createdAt: this.now(),
    };
    return {
      relationship: selected.relationship,
      distance: selected.distance,
      evidence,
    };
  }

  private async buildArtifacts(
    input: AssembleAssuranceImpactPacketsInput,
    packetId: string,
    locations: AssuranceSourceLocation[],
    eligiblePaths: Set<string>,
    cancellation: AssuranceOperationCancellation | undefined,
  ): Promise<{
    artifacts: ImpactPacketArtifact[];
    includedPaths: Set<string>;
    limitations: AssuranceCoverageLimitation[];
  }> {
    if (locations.some((location) => !isEligibleInventoryPath(location.path, eligiblePaths))) {
      throw new Error('Impact packet context paths must belong to the exact source inventory.');
    }
    const grouped = new Map<string, AssuranceSourceLocation[]>();
    for (const location of locations) {
      grouped.set(location.path, [...(grouped.get(location.path) ?? []), location]);
    }
    const paths = [...grouped.keys()];
    const selectedPaths = paths.slice(0, input.limits.maxFilesPerPacket);
    const limitations: AssuranceCoverageLimitation[] = [];
    if (paths.length > selectedPaths.length) {
      limitations.push(
        limitation(
          `${packetId}:file-limit`,
          'IMPACT_PACKET_FILE_LIMIT',
          `${paths.length - selectedPaths.length} context files were omitted by the packet file limit.`,
          paths.slice(selectedPaths.length),
        ),
      );
    }

    let remainingBytes = input.limits.maxPacketBytes;
    const artifacts: ImpactPacketArtifact[] = [];
    const includedPaths = new Set<string>();
    for (const path of selectedPaths) {
      if (await canceled(cancellation)) throw new ImpactPacketAssemblyCanceledError();
      let source: string;
      try {
        source = await this.options.checkouts.readEligibleTextFile(input.checkoutRef, path, this.maxSourceFileBytes);
      } catch {
        limitations.push(
          limitation(
            `${packetId}:source-unavailable:${stableId('path', path)}`,
            'IMPACT_SOURCE_UNAVAILABLE',
            'An indexed source file could not be read for packet assembly.',
            [path],
          ),
        );
        continue;
      }
      const rawSnippet = snippet(source, grouped.get(path) ?? [{ path }]);
      let redacted: string;
      try {
        redacted = await this.options.redact({
          policyId: input.redactionPolicyId,
          path,
          content: rawSnippet,
        });
      } catch {
        throw new Error('Impact packet redaction failed.');
      }
      const withHeader = `# ${path}\n${redacted}`;
      const bounded = truncateUtf8(withHeader, remainingBytes);
      if (!bounded.value.length) {
        limitations.push(
          limitation(
            `${packetId}:byte-limit`,
            'IMPACT_PACKET_BYTE_LIMIT',
            'Packet content reached the configured byte limit.',
            [path],
          ),
        );
        break;
      }
      const ref = stableId('impact-artifact', `${packetId}:${path}`);
      const artifact: ImpactPacketArtifact = {
        ref,
        revisionSha: input.revision.headSha,
        path,
        content: bounded.value,
        byteCount: Buffer.byteLength(bounded.value),
      };
      artifacts.push(artifact);
      includedPaths.add(path);
      remainingBytes -= artifact.byteCount;
      if (bounded.truncated) {
        limitations.push(
          limitation(
            `${packetId}:byte-limit`,
            'IMPACT_PACKET_BYTE_LIMIT',
            'Packet content was truncated at the configured byte limit.',
            [path],
          ),
        );
        break;
      }
    }
    return { artifacts, includedPaths, limitations };
  }
}
