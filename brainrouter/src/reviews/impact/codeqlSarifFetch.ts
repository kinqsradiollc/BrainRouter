// ADR-039 S2 — fetch CodeQL code-scanning SARIF for an exact ref and map it to
// the review pipeline's source→sink evidence.
//
// The paths live only in the raw SARIF, so this lists the code-scanning analyses
// for the ref, picks the newest for the target language, fetches that analysis
// with `Accept: application/sarif+json`, and runs the pure mapper. Every network
// call is injected (`fetchImpl`) so this is unit-testable without GitHub. A repo
// with code scanning disabled, or no analysis for the ref, yields no paths — the
// review reports "not analyzed" (ADR-039 §4 / Golden rule 23) rather than
// treating absence as safety; that decision is the caller's.

import type { AssuranceSourceToSinkPath } from "@kinqs/brainrouter-types/review";
import {
  mapCodeqlSarifToSourceToSinkPaths,
  type CodeqlSarif,
} from "./codeqlSarifMapping.js";

/** The subset of a fetch Response this module needs; matches global fetch. */
export interface SarifFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type SarifFetchImpl = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<SarifFetchResponse>;

interface CodeScanningAnalysisSummary {
  id: number;
  category?: string;
  created_at?: string;
}

function ghHeaders(
  token: string,
  accept = "application/vnd.github+json",
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Pick the newest analysis whose category names the target language. The
 * code-scanning analyses list is returned newest-first, so the first category
 * match is the latest. Returns null when nothing matches.
 */
export function selectAnalysisId(
  analyses: readonly CodeScanningAnalysisSummary[],
  languageNeedle = "javascript",
): number | null {
  const needle = languageNeedle.toLowerCase();
  for (const a of analyses) {
    if ((a.category ?? "").toLowerCase().includes(needle)) return a.id;
  }
  return null;
}

export interface FetchCodeqlPathsInput {
  /** Validated GitHub API base, e.g. `https://api.github.com`. */
  apiBase: string;
  /** `owner/name`. */
  repo: string;
  /** Ref to analyze — `refs/heads/<branch>` or a commit SHA. */
  ref: string;
  /** Bearer token (installation or user token from the review auth path). */
  token: string;
  fetchImpl: SarifFetchImpl;
  /** Language category substring to select (default `javascript`). */
  languageCategory?: string;
}

/**
 * Fetch and map the CodeQL source→sink paths for a ref. Returns `[]` when code
 * scanning is unavailable for the ref (non-2xx on the analyses list or the SARIF
 * fetch, or no matching analysis) so the caller can surface "not analyzed".
 */
export async function fetchCodeqlSourceToSinkPaths(
  input: FetchCodeqlPathsInput,
): Promise<AssuranceSourceToSinkPath[]> {
  const { apiBase, repo, ref, token, fetchImpl } = input;
  const needle = (input.languageCategory ?? "javascript").toLowerCase();

  const listUrl = `${apiBase}/repos/${repo}/code-scanning/analyses?ref=${encodeURIComponent(
    ref,
  )}&per_page=50`;
  const listRes = await fetchImpl(listUrl, { headers: ghHeaders(token) });
  if (!listRes.ok) return [];
  const analyses = (await listRes.json()) as CodeScanningAnalysisSummary[];
  if (!Array.isArray(analyses)) return [];

  const id = selectAnalysisId(analyses, needle);
  if (id == null) return [];

  const sarifRes = await fetchImpl(
    `${apiBase}/repos/${repo}/code-scanning/analyses/${id}`,
    { headers: ghHeaders(token, "application/sarif+json") },
  );
  if (!sarifRes.ok) return [];
  const sarif = (await sarifRes.json()) as CodeqlSarif;
  return mapCodeqlSarifToSourceToSinkPaths(sarif);
}
