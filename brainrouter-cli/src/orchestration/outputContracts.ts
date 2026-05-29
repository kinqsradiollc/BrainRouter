/**
 * MAS-P2-M5 — typed output contracts for the five built-in agent
 * roles. Each contract names the markdown sections we'd like the
 * child to produce so the parent's synthesis pass can pull
 * structured data out of free-form prose without an LLM round-trip.
 *
 * The 0.4.0 cut is **scaffolding**: the contract drives a
 * "Required structured output" block appended to the child's system
 * prompt, plus a tolerant `parseChildOutput(roleName, text)` parser
 * that returns either parsed fields or `{ contractStatus:
 * "unparsed" }`. Strict enforcement (`wait_agent --json` returning
 * the parsed fields, parent synthesis helper, rejecting unparsed)
 * lands in 0.4.1.
 *
 * Why markdown sections rather than JSON: the existing role overlays
 * already train the model on headline-first markdown. Asking for JSON
 * would compete with that and we'd lose the headline pattern that
 * the parent's `extractChildPreview()` already depends on. Sections
 * are also forgiving: a typo or a missing field returns `unparsed`
 * rather than crashing on `JSON.parse`.
 */

export interface OutputContractField {
  name: string;
  /** Markdown heading (h2/h3) that the child should produce. */
  heading: string;
  /** When true, the parser flags the contract as `unparsed` if missing. */
  required: boolean;
  /** Brief description rendered into the system prompt. */
  description: string;
}

export interface OutputContract {
  /** Stable id; matches the agent's role name. */
  id: string;
  description: string;
  fields: OutputContractField[];
}

export interface ParsedOutput {
  contractStatus: "parsed" | "unparsed";
  fields: Record<string, string>;
  /** Names of required fields the parser could not find. */
  missing: string[];
}

const EXPLORER: OutputContract = {
  id: "explorer",
  description:
    "Read-only investigator. Returns concrete file paths + facts the parent can act on.",
  fields: [
    { name: "headline", heading: "Headline", required: true, description: "≤6-line verdict + the 1–3 most important facts." },
    { name: "filesRead", heading: "Files read", required: true, description: "Bullet list of `path:line-range` references actually opened." },
    { name: "facts", heading: "Facts", required: true, description: "Bullet list of concrete observations grounded in the files above." },
    { name: "openQuestions", heading: "Open questions", required: false, description: "Anything you couldn't determine, with the question phrased so the parent can answer." },
    { name: "nextProbe", heading: "Next probe", required: false, description: "Suggested follow-up investigation if the parent needs more." },
  ],
};

const ARCHITECT: OutputContract = {
  id: "architect",
  description: "Design synthesis. Returns alternatives + a recommendation the parent can decide on.",
  fields: [
    { name: "headline", heading: "Headline", required: true, description: "≤6-line verdict; lead with the recommendation." },
    { name: "alternatives", heading: "Alternatives", required: true, description: "Numbered list of the options considered (≥2)." },
    { name: "tradeoffs", heading: "Tradeoffs", required: true, description: "Short table or bullet list: option ↔ pro / con." },
    { name: "recommendation", heading: "Recommendation", required: true, description: "Which option to pick + the deciding reason." },
    { name: "firstSlice", heading: "First slice", required: false, description: "Smallest concrete next step the parent can ship." },
  ],
};

const REVIEWER: OutputContract = {
  id: "reviewer",
  description:
    "Code review pass. Returns confidence-scored findings the parent can filter by threshold.",
  fields: [
    { name: "headline", heading: "Headline", required: true, description: "≤6-line verdict + top concern count." },
    {
      name: "findings",
      heading: "Findings",
      required: true,
      description:
        "Bulleted list. Each finding starts with `- [severity:high|medium|low] [confidence:0-100] <file>:<line>` followed by the issue, then a short fix sketch.",
    },
    { name: "outOfScope", heading: "Out of scope", required: false, description: "Things you noticed but did not address in this review." },
  ],
};

const WORKER: OutputContract = {
  id: "worker",
  description:
    "Implementer. Returns the diff summary + tests to run + risks the parent should know about.",
  fields: [
    { name: "headline", heading: "Headline", required: true, description: "≤6-line verdict — what shipped, what didn't." },
    { name: "filesChanged", heading: "Files changed", required: true, description: "Bullet list of `path` (+lines added / -lines removed) per file." },
    { name: "summary", heading: "Summary", required: true, description: "1–3 paragraphs covering what was implemented and why." },
    { name: "testsSuggested", heading: "Tests to run", required: false, description: "Exact commands or test names that should pass after this change." },
    { name: "risks", heading: "Risks", required: false, description: "Known limitations, deferred work, or anything the parent should watch on the next turn." },
  ],
};

const VERIFIER: OutputContract = {
  id: "verifier",
  description:
    "Test / smoke runner. Returns command-by-command pass/fail evidence so the parent can decide if the slice is shippable.",
  fields: [
    { name: "headline", heading: "Headline", required: true, description: "Pass / fail verdict + count of failing commands." },
    {
      name: "commands",
      heading: "Commands",
      required: true,
      description:
        "Bullet list. Each command: `- $ <command>` then `  exit: <code>` then `  stdout-tail: <last 200 chars>` (or `  failure: <message>` when it didn't even start).",
    },
    { name: "passFail", heading: "Pass / fail", required: true, description: "`PASS` or `FAIL` (one line). The parent's synthesis checks this exact token." },
    { name: "failures", heading: "Failures", required: false, description: "Detail block per failing command — the relevant log slice + likely cause." },
  ],
};

export const BUILT_IN_OUTPUT_CONTRACTS: Record<string, OutputContract> = {
  explorer: EXPLORER,
  architect: ARCHITECT,
  reviewer: REVIEWER,
  worker: WORKER,
  verifier: VERIFIER,
};

/**
 * Look up the built-in contract for a role / agent id. Falls back to
 * `null` for unknown ids — callers treat `null` as "no contract, no
 * prompt augmentation, no parsing".
 */
export function getOutputContract(roleName: string | undefined | null): OutputContract | null {
  if (!roleName) return null;
  return BUILT_IN_OUTPUT_CONTRACTS[roleName] ?? null;
}

/**
 * Render the contract as a "Required structured output" block that
 * gets appended to the child's system prompt. The format mirrors the
 * existing headline-first overlay (markdown sections, h2 headings)
 * so the model treats it as natural continuation, not a JSON ask.
 */
export function describeContractForPrompt(contract: OutputContract): string {
  const lines: string[] = [
    "## Required structured output",
    `Your final response MUST include the markdown sections below. The parent's synthesis pass parses these headings — without them, the parent only sees the headline preview and your work is recorded as \`contractStatus: "unparsed"\`.`,
    "",
  ];
  for (const field of contract.fields) {
    const tag = field.required ? "" : " *(optional)*";
    lines.push(`### ${field.heading}${tag}`);
    lines.push(field.description);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Parse a child's final answer against its contract.
 *
 * We match each field's heading at the start of a line (h1/h2/h3
 * accepted to be forgiving — the model occasionally promotes/demotes
 * by one level). Body is everything until the next h1/h2/h3 or EOF.
 * The parser is intentionally tolerant: any markdown heading that
 * isn't a known field is ignored without failing the whole contract.
 *
 * Returns `{ contractStatus: "parsed", fields }` when every REQUIRED
 * field was found with non-empty content. Otherwise
 * `{ contractStatus: "unparsed", fields, missing }` so the caller
 * can render the partial map AND surface which fields were missing.
 */
export function parseChildOutput(
  roleName: string | undefined | null,
  text: string | undefined | null,
): ParsedOutput | null {
  const contract = getOutputContract(roleName);
  if (!contract) return null;
  if (!text || typeof text !== "string") {
    return { contractStatus: "unparsed", fields: {}, missing: contract.fields.filter((f) => f.required).map((f) => f.name) };
  }

  const fields: Record<string, string> = {};
  // Pre-compute heading lookup so a single pass over the text is enough.
  const headingMap = new Map<string, OutputContractField>();
  for (const f of contract.fields) headingMap.set(normaliseHeading(f.heading), f);

  // Scan the text by lines; a markdown heading flips us into the body
  // of the corresponding field until the next heading appears.
  let activeField: OutputContractField | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (activeField) {
      const body = buffer.join("\n").trim();
      if (body) fields[activeField.name] = body;
    }
    buffer = [];
  };

  for (const line of text.split(/\r?\n/)) {
    // h1/h2/h3 followed by the heading text. The `*(optional)*` tag
    // is itself optional — `(?:…)?` wraps the whole trailing group so
    // a plain `## Headline` matches as well as `## Headline *(optional)*`.
    const headingMatch = /^\s*(#{1,3})\s+(.+?)(?:\s+\*?\(optional\)\*?)?\s*$/i.exec(line);
    if (headingMatch) {
      const candidate = normaliseHeading(headingMatch[2]);
      const next = headingMap.get(candidate);
      if (next) {
        flush();
        activeField = next;
        continue;
      }
      // Unknown heading at the same level — close the active field
      // so its body doesn't leak into the next section. A subsequent
      // known heading will re-open scanning.
      flush();
      activeField = null;
      continue;
    }
    if (activeField) buffer.push(line);
  }
  flush();

  const missing = contract.fields
    .filter((f) => f.required && (!fields[f.name] || fields[f.name].trim().length === 0))
    .map((f) => f.name);
  const status: ParsedOutput["contractStatus"] = missing.length === 0 ? "parsed" : "unparsed";
  return { contractStatus: status, fields, missing };
}

function normaliseHeading(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[*_`]/g, "")
    .trim();
}
