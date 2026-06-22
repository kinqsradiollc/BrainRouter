import { getCliKnobs } from '../config/config.js';

export type RecallMode = 'always' | 'gated' | 'off';

export type BriefingDecisionAction = 'fire' | 'hint-only' | 'skip';

export interface BriefingTriggerInput {
  prompt: string;
  recallMode: RecallMode;
  recallHasFiredThisSession: boolean;
  postCompaction: boolean;
  hasActiveGoal: boolean;
  recentToolFailure?: string;
  turnsSinceLastFullBriefing: number;
}

export interface BriefingDecision {
  action: BriefingDecisionAction;
  reasons: string[];
  query: string;
  budget: {
    maxCharsPerSource: number;
    maxSources: number;
  };
}

const CONTINUATION_RE = /\b(continue|resume|same issue|same bug|that file again|where we left off|previous|earlier|handoff|pick up)\b/i;
const MEMORY_RE = /\b(memory|recall|remember|what did we decide|decision|history|prior|past)\b/i;
const DEBUG_RE = /\b(error|failed|failure|regression|bug|fix|debug|retry|blocked|crash|exception|stack trace)\b/i;
const CHILD_SYNTHESIS_RE = /\b(child agent|subagent|worker result|agent result|synthesize|synthesis|merge the results|combine the results)\b/i;
const SOCIAL_RE = /^(thanks|thank you|ok|okay|cool|nice|great|got it|yep|yes|no|sure|sounds good)[.!? ]*$/i;

export function resolveRecallMode(): RecallMode {
  return getCliKnobs().recallMode;
}

/**
 * Cheap local heuristic for "the user message names something specific
 * memory might have history on." Counts file paths, identifier-shaped
 * tokens, and mid-sentence proper nouns.
 */
export function countEntityTokens(text: string): number {
  if (!text) return 0;
  let count = 0;
  const pathMatches = text.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z]{1,8}(?![A-Za-z])|(?:[\w-]+\/){1,}[\w.-]+/g);
  if (pathMatches) count += pathMatches.length;
  const identMatches = text.match(/\b(?:[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z]+[A-Z][A-Za-z0-9]+|[a-z]+_[a-z][\w]+)\b/g);
  if (identMatches) count += identMatches.length;
  const sentences = text.split(/[.!?]\s+/);
  for (const s of sentences) {
    const words = s.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/[^A-Za-z]/g, '');
      if (w.length >= 3 && /^[A-Z][a-z]+$/.test(w)) count++;
    }
  }
  return count;
}

export function extractFilePathHints(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z]{1,8}(?![A-Za-z])|(?:[\w-]+\/){1,}[\w.-]+/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.replace(/^["'`]|["'`]$/g, '')))).slice(0, 5);
}

export function looksLikeDebugOrRetry(text: string): boolean {
  return DEBUG_RE.test(text);
}

export function decideMemoryBriefing(input: BriefingTriggerInput): BriefingDecision {
  const prompt = input.prompt.trim();
  const reasons: string[] = [];
  const knobs = getCliKnobs();
  const maxCharsPerSource = knobs.briefingMaxCharsPerSource;
  const maxSources = knobs.briefingMaxSources;

  if (input.recallMode === 'off') {
    return {
      action: 'skip',
      reasons: ['recallMode=off'],
      query: prompt,
      budget: { maxCharsPerSource, maxSources },
    };
  }

  if (input.recallMode === 'always') reasons.push('recallMode=always');
  if (!input.recallHasFiredThisSession) reasons.push('first turn in session');
  if (input.postCompaction) reasons.push('post-compaction context refresh');
  if (CONTINUATION_RE.test(prompt)) reasons.push('continuation cue');
  if (MEMORY_RE.test(prompt)) reasons.push('explicit memory/history cue');
  if (looksLikeDebugOrRetry(prompt)) reasons.push('debug or retry cue');
  if (CHILD_SYNTHESIS_RE.test(prompt)) reasons.push('child-agent synthesis cue');
  if (input.recentToolFailure) reasons.push('recent tool failure');
  if (input.hasActiveGoal && input.turnsSinceLastFullBriefing >= 2) reasons.push('active goal periodic refresh');
  if (input.turnsSinceLastFullBriefing >= 4) reasons.push('periodic refresh');

  const entityHits = countEntityTokens(prompt);
  if (entityHits >= 2) reasons.push(`entity cue (${entityHits})`);

  const fileHints = extractFilePathHints(prompt);
  if (fileHints.length > 0) reasons.push('file path cue');

  if (reasons.length > 0) {
    return {
      action: 'fire',
      reasons,
      query: prompt,
      budget: { maxCharsPerSource, maxSources },
    };
  }

  if (!prompt || SOCIAL_RE.test(prompt)) {
    return {
      action: 'skip',
      reasons: ['low-information social reply'],
      query: prompt,
      budget: { maxCharsPerSource, maxSources },
    };
  }

  return {
    action: 'hint-only',
    reasons: ['gated mode: no memory trigger'],
    query: prompt,
    budget: { maxCharsPerSource, maxSources },
  };
}
