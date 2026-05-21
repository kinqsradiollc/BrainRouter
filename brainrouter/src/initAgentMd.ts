import fs from 'node:fs';
import path from 'node:path';

const TEMPLATE = `# AGENT.md

> Instructions for AI coding agents (BrainRouter CLI, Claude Code, Codex CLI) working in this repo.

## Project context

Describe what this project is and the high-level architecture in 2-3 sentences.

## Build, test, run

- Install: \`npm install\`
- Build:   \`npm run build\`
- Test:    \`npm test\`
- Run dev: \`npm run dev\`

## Conventions

- Code style: …
- Testing: …
- Commits: conventional commits (\`feat\`, \`fix\`, \`chore\`, …).

## Boundaries

- Always do: run tests before claiming work is complete; cite memory record ids when used.
- Ask first: schema migrations, dependency upgrades, anything that touches secrets.
- Never do: commit \`.env\` or anything matching \`*.key\`, modify \`vendor/\`, skip git hooks.

## Skill hints

If you have catalogued skills relevant to this repo, list them here so the
\`memory_register_skill_hints\` tool can warm them up automatically:

- ${"`code-review-and-quality`"} — use before merging.
- ${"`agentic-engineering-workflow`"} — use for /feature-dev.
`;

export interface InitResult {
  status: 'created' | 'exists';
  path: string;
}

/**
 * Create AGENT.md in the workspace root if neither AGENT.md nor AGENTS.md is
 * already present. Idempotent: returns { status: 'exists' } when something
 * already lives there.
 *
 * We use AGENT.md (singular) as the canonical name — BrainRouter, Claude Code,
 * and Codex CLI all read both spellings, so a singular file works everywhere.
 */
export function initAgentMd(workspaceRoot: string): InitResult {
  const candidates = ['AGENT.md', 'AGENTS.md'].map((name) => path.join(workspaceRoot, name));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { status: 'exists', path: candidate };
    }
  }
  const target = candidates[0];
  fs.writeFileSync(target, TEMPLATE, 'utf8');
  return { status: 'created', path: target };
}
