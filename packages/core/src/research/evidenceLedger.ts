/**
 * RESEARCH EVIDENCE LEDGER (§5.2) — the pure core of the `/research` brief.
 *
 * Evidence-driven research keeps a LEDGER of findings: each entry is a claim,
 * the sources backing it, whether they support / refute / are unclear about it,
 * and a confidence. From that the engine derives cross-checks (a claim is
 * "corroborated" when independent sources agree, "conflicting" when sources
 * disagree, "single-source" when it rests on one citation) and renders a
 * report-ready markdown brief with an explicit uncertainty section.
 *
 * Pure data + pure functions (no fs, no LLM) — the agent populates the ledger
 * during a research turn (via the research_note tool over the shipped web-search)
 * and emits the brief (research_brief). Persistence lives in researchStore.ts.
 */

export type Stance = 'support' | 'refute' | 'unclear';
export type Confidence = 'high' | 'medium' | 'low';

export interface EvidenceSource {
  /** Canonical HTTP(S) URL with fragments and tracking parameters removed. */
  url: string;
  title?: string;
  publisher?: string;
  authors?: string[];
  publishedDate?: string;
  accessedAt: string;
  /** The specific passage, datum, or observation that bears on the claim. */
  evidence?: string;
  /** Source-specific caveat such as methodology, recency, or access limits. */
  limitations?: string;
}

export interface EvidenceEntry {
  id: string;
  claim: string;
  /** URLs or short source descriptions backing this entry. */
  sources: string[];
  /** Structured provenance for report-ready claim-to-source links. */
  sourceRecords?: EvidenceSource[];
  stance: Stance;
  confidence: Confidence;
  note?: string;
  createdAt: string;
}

export interface ResearchLedger {
  question: string;
  entries: EvidenceEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface AddEntryInput {
  claim: string;
  sources?: string[];
  sourceRecords?: Array<Omit<EvidenceSource, 'accessedAt'> & { accessedAt?: string }>;
  stance?: Stance;
  confidence?: Confidence;
  note?: string;
}

const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i;

export function canonicalSourceUrl(raw: string): string {
  const value = raw.trim();
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value;
  }
}

function bounded(value: string | undefined, max: number): string | undefined {
  const text = value?.trim().slice(0, max);
  return text || undefined;
}

function normalizeSource(
  source: Omit<EvidenceSource, 'accessedAt'> & { accessedAt?: string },
  now: string,
): EvidenceSource | null {
  const url = canonicalSourceUrl(String(source.url ?? ''));
  if (!/^https?:\/\//i.test(url)) return null;
  const authors = (source.authors ?? []).map((author) => bounded(String(author), 200)).filter((author): author is string => !!author).slice(0, 20);
  return {
    url,
    accessedAt: bounded(source.accessedAt, 64) ?? now,
    ...(bounded(source.title, 500) ? { title: bounded(source.title, 500) } : {}),
    ...(bounded(source.publisher, 300) ? { publisher: bounded(source.publisher, 300) } : {}),
    ...(authors.length ? { authors } : {}),
    ...(bounded(source.publishedDate, 64) ? { publishedDate: bounded(source.publishedDate, 64) } : {}),
    ...(bounded(source.evidence, 4_000) ? { evidence: bounded(source.evidence, 4_000) } : {}),
    ...(bounded(source.limitations, 2_000) ? { limitations: bounded(source.limitations, 2_000) } : {}),
  };
}

export function createLedger(question: string, now: string): ResearchLedger {
  return { question: question.trim(), entries: [], createdAt: now, updatedAt: now };
}

/** Append an evidence entry, returning a NEW ledger (pure). Ids are deterministic (`ev_<n>`). */
export function addEntry(ledger: ResearchLedger, input: AddEntryInput, now: string): ResearchLedger {
  const claim = input.claim.trim();
  if (!claim) throw new Error('an evidence entry needs a non-empty claim.');
  const sourceRecordsByUrl = new Map<string, EvidenceSource>();
  for (const candidate of input.sourceRecords ?? []) {
    const source = normalizeSource(candidate, now);
    if (source && !sourceRecordsByUrl.has(source.url)) sourceRecordsByUrl.set(source.url, source);
    if (sourceRecordsByUrl.size >= 50) break;
  }
  const sourceRecords = [...sourceRecordsByUrl.values()];
  const entry: EvidenceEntry = {
    id: `ev_${ledger.entries.length + 1}`,
    claim,
    sources: (input.sources ?? []).map((s) => s.trim()).filter(Boolean),
    ...(sourceRecords.length ? { sourceRecords } : {}),
    stance: input.stance ?? 'unclear',
    confidence: input.confidence ?? 'low',
    createdAt: now,
    ...(input.note && input.note.trim() ? { note: input.note.trim() } : {}),
  };
  return { ...ledger, entries: [...ledger.entries, entry], updatedAt: now };
}

function normClaim(claim: string): string {
  return claim.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ClaimCrossCheck {
  claim: string;
  entries: EvidenceEntry[];
  /** Distinct sources across the claim's entries. */
  sourceCount: number;
  /** Has both a support AND a refute entry. */
  conflicting: boolean;
  /** ≥2 distinct sources and not conflicting. */
  corroborated: boolean;
  /** Exactly one distinct source and not conflicting. */
  singleSource: boolean;
}

/** Group entries by normalized claim and classify each (corroborated / conflicting / single-source). */
export function crossCheck(ledger: ResearchLedger): ClaimCrossCheck[] {
  const byClaim = new Map<string, EvidenceEntry[]>();
  for (const e of ledger.entries) {
    const key = normClaim(e.claim);
    const list = byClaim.get(key) ?? [];
    list.push(e);
    byClaim.set(key, list);
  }
  const out: ClaimCrossCheck[] = [];
  for (const entries of byClaim.values()) {
    const sources = new Set(entries.flatMap((e) => [
      ...e.sources.map(canonicalSourceUrl),
      ...(e.sourceRecords ?? []).map((source) => source.url),
    ]));
    const stances = new Set(entries.map((e) => e.stance));
    const conflicting = stances.has('support') && stances.has('refute');
    const sourceCount = sources.size;
    out.push({
      claim: entries[0].claim,
      entries,
      sourceCount,
      conflicting,
      corroborated: !conflicting && sourceCount >= 2,
      singleSource: !conflicting && sourceCount === 1,
    });
  }
  return out;
}

export interface LedgerSummary {
  total: number;
  corroborated: number;
  conflicting: number;
  singleSource: number;
}

export function summarizeLedger(ledger: ResearchLedger): LedgerSummary {
  const checks = crossCheck(ledger);
  return {
    total: ledger.entries.length,
    corroborated: checks.filter((c) => c.corroborated).length,
    conflicting: checks.filter((c) => c.conflicting).length,
    singleSource: checks.filter((c) => c.singleSource).length,
  };
}

const STANCE_MARK: Record<Stance, string> = { support: '✓', refute: '✗', unclear: '?' };

/** Render the ledger as a report-ready markdown brief with an uncertainty section. */
export function formatBrief(ledger: ResearchLedger): string {
  const summary = summarizeLedger(ledger);
  const checks = crossCheck(ledger);
  const lines: string[] = [];
  lines.push(`# Research brief: ${ledger.question || '(no question set)'}`);
  lines.push('');
  lines.push(
    `_${summary.total} finding${summary.total === 1 ? '' : 's'} · ${summary.corroborated} corroborated · ${summary.conflicting} conflicting · ${summary.singleSource} single-source_`,
  );
  lines.push('');

  lines.push('## Findings');
  if (ledger.entries.length === 0) {
    lines.push('_No evidence recorded yet._');
  }
  for (const e of ledger.entries) {
    lines.push('');
    lines.push(`### ${STANCE_MARK[e.stance]} ${e.claim}`);
    lines.push(`- stance: **${e.stance}** · confidence: **${e.confidence}**`);
    if (e.sources.length) {
      lines.push('- sources:');
      for (const s of e.sources) lines.push(`  - ${s}`);
    } else {
      lines.push('- sources: _none cited_');
    }
    if (e.sourceRecords?.length) {
      lines.push('- source records:');
      for (const source of e.sourceRecords) {
        const identity = [source.authors?.join(', '), source.publisher, source.publishedDate].filter(Boolean).join(' · ');
        lines.push(`  - [${source.title || source.url}](${source.url})${identity ? ` — ${identity}` : ''}`);
        if (source.evidence) lines.push(`    - evidence: ${source.evidence}`);
        if (source.limitations) lines.push(`    - limitations: ${source.limitations}`);
        lines.push(`    - accessed: ${source.accessedAt}`);
      }
    }
    if (e.note) lines.push(`- note: ${e.note}`);
  }

  const conflicts = checks.filter((c) => c.conflicting);
  const singles = checks.filter((c) => c.singleSource);
  if (conflicts.length || singles.length) {
    lines.push('');
    lines.push('## Uncertainty & conflicts');
    for (const c of conflicts) {
      lines.push(`- ⚠️ **Conflicting evidence** on: ${c.claim} (${c.entries.length} entries disagree)`);
    }
    for (const c of singles) {
      lines.push(`- 🔎 **Single source** (verify): ${c.claim}`);
    }
  }
  return lines.join('\n');
}
