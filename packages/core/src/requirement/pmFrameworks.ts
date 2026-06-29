/**
 * PM-SKILL FRAMEWORK REGISTRY (0.4.16) — a pure-data set of product-manager
 * "frameworks" the requirements UI offers as one-click buttons.
 *
 * Two-step contract (the load-bearing behaviour):
 *   1. Clicking a framework button injects its `composerText` into the composer
 *      — it does NOT auto-send. The user can edit or delete the text first.
 *   2. On send, a framework's `guidance` is injected into the system prompt
 *      ONLY IF its `composerText` is still present in the composed message
 *      (see {@link isFrameworkArmed}). Edit the prompt away and the framework
 *      silently disarms — no hidden system steering the user didn't ask for.
 *
 * Pure data + pure helpers (no fs, no LLM, no store) so the set is unit-testable
 * and shared verbatim by CLI and desktop. Grouped discover / structure / risk.
 */

export type PmFrameworkGroup = 'discover' | 'structure' | 'risk';

export interface PmFramework {
  /** Stable kebab-case id. */
  id: string;
  group: PmFrameworkGroup;
  /** Short button label. */
  label: string;
  /** Text injected into the composer on click (not auto-sent). */
  composerText: string;
  /** System-prompt guidance injected at send time IFF composerText is still present. */
  guidance: string;
}

export const PM_FRAMEWORKS: readonly PmFramework[] = [
  // ---- discover: surface what we don't yet know -------------------------
  {
    id: 'clarify-missing',
    group: 'discover',
    label: 'Clarify missing questions',
    composerText:
      'Before building, list the open questions that must be answered for this to be unambiguous.',
    guidance:
      'Act as a product manager in DISCOVER mode. Surface the smallest set of high-leverage clarifying questions whose answers most change the design. Group them by theme, mark each blocking or non-blocking, and propose a sensible default for each so work can proceed even if a question goes unanswered.',
  },
  {
    id: 'pre-implementation-research',
    group: 'discover',
    label: 'Pre-implementation research',
    composerText:
      'Research what already exists in this codebase and ecosystem before proposing an approach.',
    guidance:
      'Investigate prior art first: existing code, libraries, and constraints relevant to this work, citing file:line evidence. Do NOT propose a design until the landscape is mapped; call out anything we would be reinventing.',
  },
  // ---- structure: shape the intent into testable units ------------------
  {
    id: 'split-r-blocks',
    group: 'structure',
    label: 'Split into R-blocks',
    composerText:
      'Break this into discrete requirements, each with an id, a title, and verifiable acceptance criteria.',
    guidance:
      'Decompose the intent into atomic requirements written as `### R-n: <title>` headings, each with `- [ ]` acceptance-criterion checkboxes that are independently observable and testable. Avoid overlap between requirements; every criterion must be checkable against real code or a test.',
  },
  {
    id: 'user-stories-invest',
    group: 'structure',
    label: 'User stories (INVEST)',
    composerText:
      'Express this as user stories that satisfy INVEST (Independent, Negotiable, Valuable, Estimable, Small, Testable).',
    guidance:
      'Write the work as `As a <role>, I want <capability>, so that <value>` stories. Check each against INVEST and flag any that are not Independent, Small, or Testable, splitting them until they are.',
  },
  {
    id: 'acceptance-criteria-gwt',
    group: 'structure',
    label: 'Acceptance criteria (G/W/T)',
    composerText:
      'Write acceptance criteria in Given / When / Then form for each requirement, including edge and failure cases.',
    guidance:
      'Express acceptance criteria as concrete Given/When/Then scenarios. Cover the happy path plus edge and failure cases; each scenario must map to a check (a test or an observable behaviour).',
  },
  // ---- risk: stress-test before committing ------------------------------
  {
    id: 'pre-mortem',
    group: 'risk',
    label: 'Pre-mortem',
    composerText:
      'Imagine this shipped and failed — list the most likely failure modes and how to prevent each.',
    guidance:
      'Run a pre-mortem: assume the feature failed in production. Enumerate the top failure modes ranked by likelihood × impact, give the earliest observable signal for each, and a concrete mitigation or guardrail.',
  },
  {
    id: 'assumption-prioritization',
    group: 'risk',
    label: 'Assumption prioritization',
    composerText:
      'List the assumptions this depends on and rank them by risk so we validate the riskiest first.',
    guidance:
      'Surface the implicit assumptions this work depends on. Score each by (impact if wrong) × (uncertainty) and recommend the cheapest validation for the highest-risk few before committing to the design.',
  },
];

/** Look up a framework by id. */
export function getPmFramework(id: string): PmFramework | undefined {
  return PM_FRAMEWORKS.find((f) => f.id === id);
}

/** All frameworks, optionally filtered to one group, in registry order. */
export function listPmFrameworks(group?: PmFrameworkGroup): PmFramework[] {
  return group ? PM_FRAMEWORKS.filter((f) => f.group === group) : [...PM_FRAMEWORKS];
}

/** Normalize for the send-time presence check: collapse whitespace, lowercase. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A framework is "armed" when its injected `composerText` is still present in
 * the composed message. Whitespace- and case-insensitive substring match so
 * trivial reformatting (a wrapped line, a trailing space) doesn't disarm it,
 * but deleting or materially rewriting the prompt does.
 */
export function isFrameworkArmed(composerValue: string, framework: PmFramework): boolean {
  const haystack = normalize(composerValue);
  const needle = normalize(framework.composerText);
  return needle.length > 0 && haystack.includes(needle);
}

/** The guidance strings of every framework still armed in `composerValue`. */
export function collectArmedGuidance(
  composerValue: string,
  frameworks: readonly PmFramework[] = PM_FRAMEWORKS,
): string[] {
  return frameworks.filter((f) => isFrameworkArmed(composerValue, f)).map((f) => f.guidance);
}

/**
 * Joined system-prompt addendum for the armed frameworks, or `''` when none are
 * armed (caller can skip injection entirely on empty).
 */
export function composeArmedSystemAddendum(
  composerValue: string,
  frameworks: readonly PmFramework[] = PM_FRAMEWORKS,
): string {
  const guidance = collectArmedGuidance(composerValue, frameworks);
  if (guidance.length === 0) return '';
  return ['Active product-management frameworks for this turn:', ...guidance.map((g) => `- ${g}`)].join('\n');
}
