import type { RequirementStatus } from '@kinqs/brainrouter-types';

export interface RequirementDetectionContext {
  autoCreateThreshold?: number;
  lowActThreshold?: number;
  openRequirements?: Array<{
    title: string;
    acceptanceCriteria: string[];
    status: RequirementStatus;
  }>;
  plannerStrategy?: 'build' | 'workflow' | 'investigate' | 'answer-direct' | 'fan-out';
}
export interface RequirementDetection {
  detected: boolean;
  candidate: boolean;
  duplicate: boolean;
  confidence: number;
  input?: {
    title: string;
    description: string;
    acceptanceCriteria: string[];
  };
  clarify?: string;
}

const IMPERATIVE = /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(add|build|create|enable|fix|implement|improve|integrate|migrate|refactor|remove|support|update)\s+(.+)$/i;
const QUESTION_OR_EXPLORATION = /^(?:what|why|where|when|who|how|is|are|do|does|did|maybe|i wonder|do you think)\b/i;
const GENERIC_OBJECTS = new Set(['it', 'this', 'that', 'something', 'anything', 'everything']);
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'with', 'in', 'on']);

function threshold(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part && !STOP_WORDS.has(part))
    .join(' ');
}

function isDuplicate(
  input: NonNullable<RequirementDetection['input']>,
  requirements: RequirementDetectionContext['openRequirements'],
): boolean {
  if (!requirements) return false;
  const title = normalized(input.title);
  const criteria = new Set(input.acceptanceCriteria.map(normalized));
  return requirements.some((requirement) =>
    requirement.status !== 'done'
    && requirement.status !== 'archived'
    && (normalized(requirement.title) === title
      || requirement.acceptanceCriteria.some((criterion) => criteria.has(normalized(criterion)))),
  );
}

function sentence(value: string): string {
  const trimmed = value.replace(/[.?!]+$/, '').trim();
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

export function detectRequirementShapedPrompt(
  prompt: string,
  context: RequirementDetectionContext = {},
): RequirementDetection {
  const text = prompt.trim();
  if (!text || QUESTION_OR_EXPLORATION.test(text) || text.endsWith('?')) {
    return { detected: false, candidate: false, duplicate: false, confidence: 0 };
  }
  const match = text.match(IMPERATIVE);
  if (!match) return { detected: false, candidate: false, duplicate: false, confidence: 0 };

  const object = match[2].replace(/[.?!]+$/, '').trim();
  const objectWords = object.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!object || GENERIC_OBJECTS.has(object.toLowerCase())) {
    return { detected: false, candidate: false, duplicate: false, confidence: 0 };
  }

  const hasScope = /\b(to|for|with|into|from|in|on|across)\b/i.test(object);
  let confidence = 0.4 + (objectWords.length >= 3 ? 0.25 : 0.15) + (hasScope ? 0.15 : 0);
  if (/\b(acceptance|must|should|test|verify)\b/i.test(text)) confidence += 0.05;
  if (context.plannerStrategy === 'build' || context.plannerStrategy === 'workflow') confidence += 0.1;
  confidence = Math.min(0.95, confidence);

  const input = {
    title: `${match[1].charAt(0).toUpperCase()}${match[1].slice(1).toLowerCase()} ${object}`,
    description: text,
    acceptanceCriteria: [sentence(`${match[1]} ${object}`)],
  };
  const duplicate = isDuplicate(input, context.openRequirements);
  const autoCreateThreshold = threshold(context.autoCreateThreshold, 0.7);
  const lowActThreshold = Math.min(threshold(context.lowActThreshold, 0.4), autoCreateThreshold);
  const clarify = hasScope ? undefined : 'What scope and observable outcome should this change cover?';

  if (duplicate || confidence < lowActThreshold) {
    return { detected: false, candidate: false, duplicate, confidence, input, clarify };
  }
  if (confidence < autoCreateThreshold) {
    return { detected: false, candidate: true, duplicate: false, confidence, input, clarify };
  }
  return { detected: true, candidate: false, duplicate: false, confidence, input, clarify };
}
