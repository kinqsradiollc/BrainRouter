// ADR-039 D4 — OUR barriers, modeled as versioned data.
//
// > A generic taint model does not know that `fetchUpstreamWithPolicy` is the
// > SSRF chokepoint, that `redactReviewSourceText` sanitizes source before it is
// > stored, that `isSafeRepositoryRelativePath` plus inventory membership bounds a
// > path, or that `asUntrustedWorkspaceText` fences attacker content. Without being
// > told, the engine will keep reporting the code we fixed *this week* — and a
// > scanner that re-reports fixed code is one people learn to ignore.
//
// This module is that model pack: one row per BrainRouter security chokepoint a
// taint path passes THROUGH to be neutralized, named by its exact exported
// symbol(s) and defining file, with the vuln class it neutralizes and the
// invariant it enforces. It is versioned alongside the code (`version` below) so a
// new chokepoint's barrier row lands in the same PR that introduces it, and a
// parity test (`adr039BarrierPack.parity.test.ts`) fails the build if a named
// symbol no longer exists at its file — so a renamed or removed chokepoint forces
// its barrier row to be updated in the same change (D4's maintenance requirement,
// D7's "a rule a human must remember is weaker than one that fails a build").
//
// IMPORTANT — where these barriers are ENFORCED. The sound consumer of this pack
// is the DB-first taint engine itself: rendered into the CodeQL barrier model
// (a data extension the advanced-setup scan loads), where the engine PROVES the
// barrier dominates the tainted path and simply does not emit the finding. The
// pack is deliberately NOT wired into the model verifier as a textual "a barrier
// symbol appears in the path, so dispute it" rule: judged textually, without
// dataflow, that heuristic disputes exactly the true positive this release is
// judged on — the `modelProbe.ts` SSRF that was guarded on three of four paths,
// where `fetchUpstreamWithPolicy` is textually present yet a fourth path bypasses
// it. A barrier that does not dominate THIS flow is not a barrier for it, and only
// the engine has the domination/reachability facts to know the difference. See the
// owner runbook for activating the CodeQL barrier model these rows render into.

/**
 * The taint/vuln classes BrainRouter's barriers neutralize, aligned to the
 * CodeQL rule families the SARIF pipeline consumes (see `codeqlSarifMapping`).
 */
export type BarrierVulnClass =
  | "ssrf"
  | "path-traversal"
  | "secret-exposure"
  | "prompt-injection";

/** One exported chokepoint identifier and the source file that defines it. */
export interface Adr039BarrierSymbol {
  /** Exact exported identifier a taint path passes through to be neutralized. */
  name: string;
  /** Repository-relative source file (never `dist/`) that defines/exports it. */
  file: string;
}

/** One modeled barrier: the chokepoint(s), what they neutralize, and why. */
export interface Adr039Barrier {
  /** Stable kebab-case id, unique across the pack. */
  id: string;
  /** The chokepoint symbol(s); a taint path is neutralized only if it passes through one. */
  symbols: Adr039BarrierSymbol[];
  /** The vuln class(es) this barrier neutralizes. */
  neutralizes: BarrierVulnClass[];
  /** The enforced invariant — why reaching a sink through this symbol is not exploitable. */
  rationale: string;
}

/** The owned, versioned barrier model pack (ADR-039 D4). */
export interface Adr039BarrierPack {
  /** Bump when a barrier row changes, so a stale rendered CodeQL model is detectable. */
  version: string;
  barriers: readonly Adr039Barrier[];
}

/**
 * BrainRouter's own security chokepoints, verified against source. Each row's
 * symbols were confirmed to exist and to enforce the stated invariant (not merely
 * appear on the path); the parity test keeps that true over time.
 */
export const ADR039_BARRIER_PACK: Adr039BarrierPack = {
  version: "2026-08-24",
  barriers: [
    {
      id: "validate-upstream-target",
      symbols: [
        { name: "validateUpstreamTarget", file: "packages/core/src/provider/routing/transport.ts" },
        { name: "createPinnedLookup", file: "packages/core/src/provider/routing/transport.ts" },
      ],
      neutralizes: ["ssrf"],
      rationale:
        "Normalizes a provider/org-configured URL (rejects non-http(s), credentials-in-URL, scoped/wildcard hosts), resolves DNS and rejects EVERY answer that is loopback/private/link-local/cloud-metadata/reserved unless the exact origin is on a self-hosted allowlist (refused entirely in the hosted fail-closed default). Returns the frozen validated addresses; createPinnedLookup dials ONLY those and rejects any hostname mismatch, closing the DNS-rebinding TOCTOU. A body-controlled URL reaching a fetch through this pair cannot egress to an attacker-chosen internal host.",
    },
    {
      id: "fetch-upstream-with-policy",
      symbols: [
        { name: "fetchUpstreamWithPolicy", file: "brainrouter/src/services/gateway/upstreamPolicy.ts" },
      ],
      neutralizes: ["ssrf"],
      rationale:
        "The gateway/model-probe/audio egress seam. Follows redirects manually and on EVERY hop re-runs validateUpstreamTarget and rebuilds a DNS-pinned dispatcher, rejects cross-origin redirects (no secret-header leak to a foreign origin), and caps the redirect count — so the socket dials only just-validated addresses across the whole chain.",
    },
    {
      id: "policy-bound-memory-fetch",
      symbols: [
        { name: "policyBoundFetch", file: "brainrouter/src/providers/policyFetch.ts" },
        { name: "upstreamProbePolicy", file: "brainrouter/src/providers/upstreamProbePolicy.ts" },
      ],
      neutralizes: ["ssrf"],
      rationale:
        "Injected as the fetchImpl of the memory-pipeline embedding/rerank/cognitive-extraction providers; its closure awaits validateUpstreamTarget(url, policy) BEFORE dialing, throwing before any request when an org-configured endpoint is statically pointed at an internal address. upstreamProbePolicy supplies the exact-origin allowlist (paths/wildcards refused; overrides refused entirely in hosted mode).",
    },
    {
      id: "guarded-fetch-bytes",
      symbols: [
        { name: "fetchGuardedBytes", file: "packages/core/src/net/guardedFetch.ts" },
        { name: "privateAddressReason", file: "packages/core/src/net/guardedFetch.ts" },
        { name: "isBlockedAddress", file: "packages/core/src/net/guardedFetch.ts" },
      ],
      neutralizes: ["ssrf"],
      rationale:
        "The single guarded outbound fetch for person-supplied URLs (agent fetch_url, web-search crawler, bookmark preview, pasted-image). On the initial URL and every redirect it rejects non-http(s)/credentials-in-URL, enforces the optional egress allowlist, and re-resolves the host to refuse any IP isBlockedAddress flags (loopback/RFC1918/link-local/cloud-metadata/CGNAT plus the IPv6 and NAT64/6to4 encodings); unparsable literals fail closed. Body bounded before and after read; redirects capped.",
    },
    {
      id: "gitlab-track-proxy-target",
      symbols: [
        { name: "gitlabTrackProxyTarget", file: "brainrouter/src/connectors/gitlabTrackProxy.ts" },
        { name: "isSsrfBlockedHost", file: "brainrouter/src/connectors/gitlabTrackProxy.ts" },
      ],
      neutralizes: ["ssrf"],
      rationale:
        "The server-side GitLab Track credential proxy's self-managed host field is tenant-supplied; gitlabTrackProxyTarget is the ONLY thing that turns it into a dialable URL, and it returns null (no request) for any host isSsrfBlockedHost rejects — closing SSRF/credential-theft through the proxy.",
    },
    {
      id: "egress-allowlist-decision",
      symbols: [
        { name: "egressDecision", file: "packages/core/src/exec/policy/execPolicy.ts" },
        { name: "hostOf", file: "packages/core/src/exec/policy/execPolicy.ts" },
      ],
      neutralizes: ["ssrf"],
      rationale:
        "When an active (non-empty) egress allowlist is configured, egressDecision refuses an outbound URL whose host (hostOf) is not allowlisted — so a taint-controlled URL cannot egress to a non-allowlisted host through the exec/tool path.",
    },
    {
      id: "egress-tunnel-ticket-binding",
      symbols: [
        { name: "EgressTicketRegistry", file: "brainrouter/src/services/gateway/egress/egressTicket.ts" },
        { name: "isReservedOriginDeviceId", file: "brainrouter/src/services/gateway/egress/egressTicket.ts" },
      ],
      neutralizes: ["ssrf"],
      rationale:
        "The edge-tunnel relay dials only the upstream host bound to a pre-issued ticket in the registry; a client cannot name or repoint an arbitrary upstream to dial through the relay, and reserved-origin device ids are refused.",
    },
    {
      id: "review-source-redaction",
      symbols: [
        { name: "redactReviewSourceText", file: "packages/core/src/review/sourceSafety.ts" },
        { name: "readBoundedReviewSourceText", file: "packages/core/src/review/sourceSafety.ts" },
        { name: "isSensitiveReviewSourcePath", file: "packages/core/src/review/sourceSafety.ts" },
        { name: "prepareReviewDiffSource", file: "packages/core/src/review/sourceSafety.ts" },
        { name: "isSafeReviewerFilesystemPath", file: "packages/core/src/review/sourceSafety.ts" },
        { name: "assertSafeReviewerFilesystemPath", file: "packages/core/src/review/sourceSafety.ts" },
      ],
      neutralizes: ["secret-exposure", "path-traversal"],
      rationale:
        "The review source-safety seam: redactReviewSourceText strips secret-shaped tokens before source text is retained or sent to a model; the sensitive-path and safe-filesystem-path guards refuse a credential-bearing, symlinked, or out-of-tree read. A secret reaching a stored/prompt sink, or a read escaping the reviewed tree, through this seam is neutralized.",
    },
    {
      id: "safe-repository-relative-path",
      symbols: [
        { name: "isSafeRepositoryRelativePath", file: "brainrouter/src/reviews/repository-context/contracts.ts" },
        { name: "isSafeOpaqueArtifactRef", file: "brainrouter/src/reviews/repository-context/contracts.ts" },
      ],
      neutralizes: ["path-traversal"],
      rationale:
        "Rejects a caller/diff-supplied relative path that escapes the reviewed checkout root (.. segments, absolute paths) and rejects artifact-ref injection/traversal; combined with checkout inventory membership it bounds a file read/write to reviewed source. The review candidate seam drops any finding whose path fails this check.",
    },
    {
      id: "untrusted-workspace-text-fence",
      symbols: [
        { name: "asUntrustedWorkspaceText", file: "packages/core/src/workspace/participants/agentContext.ts" },
      ],
      neutralizes: ["prompt-injection"],
      rationale:
        "Fences attacker-controlled workspace text (note/database/document content) as untrusted data with a bounded length and forged-escape defense, so instructions embedded in it are not executed by the consuming model.",
    },
  ],
};

/** Every (symbol, file) pair across the pack — the parity test's work-list. */
export function allBarrierSymbols(
  pack: Adr039BarrierPack = ADR039_BARRIER_PACK,
): readonly Adr039BarrierSymbol[] {
  return pack.barriers.flatMap((barrier) => barrier.symbols);
}

/**
 * Map a CodeQL SARIF ruleId to the barrier class it belongs to, if known. Used to
 * render the barrier model per class for the CodeQL data extension (owner-activated
 * advanced setup) — NOT to auto-dispute a finding textually (see the module note).
 */
export function barrierClassForRuleId(ruleId: string): BarrierVulnClass | null {
  const rule = ruleId.toLowerCase();
  if (rule.includes("request-forgery") || rule.includes("ssrf")) return "ssrf";
  if (rule.includes("path-injection") || rule.includes("zipslip") || rule.includes("tainted-path")) {
    return "path-traversal";
  }
  if (rule.includes("clear-text") || rule.includes("sensitive-data") || rule.includes("cleartext-storage")) {
    return "secret-exposure";
  }
  if (rule.includes("prompt-injection") || rule.includes("template-injection")) return "prompt-injection";
  return null;
}
