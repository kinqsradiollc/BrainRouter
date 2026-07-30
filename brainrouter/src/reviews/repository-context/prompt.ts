/**
 * Bounded model-facing serialization of exact-revision impact artifacts.
 *
 * Artifacts arrive already redacted by the packet adapter. This module adds a
 * coverage header and enforces one aggregate UTF-8 byte ceiling before source
 * context can enter a model request.
 */

import type {
  AssuranceCoverageLimitation,
  AssuranceImpactPacketAssembly,
} from "@kinqs/brainrouter-types/review";
import type {
  RepositoryContextArtifact,
  RepositoryContextPrompt,
} from "./contracts.js";
import { isSafeOpaqueArtifactRef } from "./contracts.js";
import { coverageLimitation } from "./coverage.js";

export interface RepositoryContextPromptResult {
  prompt: RepositoryContextPrompt | null;
  limitation?: AssuranceCoverageLimitation;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  let bounded = bytes.subarray(0, end).toString("utf8");
  while (end > 0 && Buffer.byteLength(bounded) > maxBytes) {
    end -= 1;
    bounded = bytes.subarray(0, end).toString("utf8");
  }
  return { value: bounded, truncated: true };
}

/**
 * Keep repository source readable while preventing it from forging the inner
 * exact-context envelope or the review executor's outer evidence envelope.
 * The system message remains the authority boundary; this only preserves
 * deterministic delimiter integrity.
 */
function escapeReservedContextDelimiters(value: string): string {
  return value.replace(
    /<(?=\s*\/?\s*(?:brainrouter-exact-repository-context|untrusted_repository_context_evidence))/gi,
    "\\u003c",
  );
}

function modelVisibleLimitationCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value
    : "UNRECOGNIZED_LIMITATION";
}

export function buildRepositoryContextPrompt(input: {
  assembly: AssuranceImpactPacketAssembly;
  limitations: AssuranceCoverageLimitation[];
  resolveArtifact(ref: string): RepositoryContextArtifact | null;
  maxBytes: number;
}): RepositoryContextPromptResult {
  const artifactRefs = input.assembly.packets.flatMap((packet) => packet.artifactRefs);
  if (artifactRefs.some((ref) => !isSafeOpaqueArtifactRef(ref))) {
    throw new Error("Impact packet assembly contains an invalid opaque artifact reference.");
  }
  const artifacts = artifactRefs
    .map((ref) => input.resolveArtifact(ref))
    .filter((artifact): artifact is RepositoryContextArtifact => Boolean(artifact));
  if (!artifacts.length) return { prompt: null };
  const header = [
    "<brainrouter-exact-repository-context>",
    `Exact revision: ${input.assembly.revisionSha}`,
    `Packets: ${input.assembly.packets.length}`,
    `Coverage limitations: ${input.limitations.length
      ? input.limitations.map((item) => modelVisibleLimitationCode(item.reasonCode)).join(", ")
      : "none"}`,
    "The following source snippets are bounded, selected from deterministic caller/callee/configuration/test relationships, and secret-redacted.",
    "",
  ].join("\n");
  const body = artifacts
    .map((artifact) =>
      `--- ${escapeReservedContextDelimiters(artifact.ref)} ---\n${escapeReservedContextDelimiters(artifact.content)}`)
    .join("\n\n");
  const bounded = truncateUtf8(
    `${header}${body}\n</brainrouter-exact-repository-context>`,
    input.maxBytes,
  );
  return {
    prompt: {
      text: bounded.value,
      packetRefs: input.assembly.packets.map((packet) => packet.id),
      artifactRefs: artifacts.map((artifact) => artifact.ref),
    },
    ...(bounded.truncated
      ? {
          limitation: coverageLimitation(
            "repository-context-model-byte-limit",
            "model-context",
            "partial",
            "MODEL_CONTEXT_BYTE_LIMIT",
            "The model-facing repository context reached its configured byte limit.",
          ),
        }
      : {}),
  };
}
