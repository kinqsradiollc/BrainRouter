import fs from 'node:fs';
import path from 'node:path';

/**
 * Repo-signal scan. We sniff for common project files and use that to populate
 * the AGENT.md template with realistic guesses instead of a blank "Describe…"
 * placeholder. Detected signals appear under "Detected project signals" so the
 * user can verify them at a glance.
 */
function detectRepoSignals(root: string) {
  const hits: string[] = [];
  const buildCmds: string[] = [];
  const testCmds: string[] = [];

  const has = (rel: string) => fs.existsSync(path.join(root, rel));
  const read = (rel: string): string | undefined => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return undefined; }
  };

  if (has('package.json')) {
    hits.push('Node.js / npm (`package.json`)');
    try {
      const pkg = JSON.parse(read('package.json') ?? '{}');
      const scripts = pkg.scripts ?? {};
      if (scripts.build) buildCmds.push('npm run build');
      if (scripts.dev) buildCmds.push('npm run dev');
      if (scripts.test) testCmds.push('npm test');
      if (scripts.lint) testCmds.push('npm run lint');
      if (scripts.typecheck) testCmds.push('npm run typecheck');
      if (pkg.workspaces) hits.push('npm workspaces (monorepo)');
    } catch { /* malformed package.json — skip */ }
  }
  if (has('pnpm-workspace.yaml') || has('pnpm-lock.yaml')) hits.push('pnpm');
  if (has('yarn.lock')) hits.push('yarn');
  if (has('tsconfig.json')) hits.push('TypeScript (`tsconfig.json`)');
  if (has('go.mod')) {
    hits.push('Go (`go.mod`)');
    buildCmds.push('go build ./...');
    testCmds.push('go test ./...');
  }
  if (has('Cargo.toml')) {
    hits.push('Rust (`Cargo.toml`)');
    buildCmds.push('cargo build');
    testCmds.push('cargo test');
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    hits.push('Python');
    if (has('pytest.ini') || (read('pyproject.toml') ?? '').includes('pytest')) {
      testCmds.push('pytest');
    }
  }
  if (has('Gemfile')) hits.push('Ruby (`Gemfile`)');
  if (has('Dockerfile')) hits.push('Docker (`Dockerfile`)');
  if (has('docker-compose.yml') || has('docker-compose.yaml') || has('compose.yaml')) hits.push('Docker Compose');
  if (has('.github/workflows')) hits.push('GitHub Actions CI');
  if (has('.gitlab-ci.yml')) hits.push('GitLab CI');
  if (has('Makefile')) {
    hits.push('Makefile');
    buildCmds.push('make');
    testCmds.push('make test');
  }
  if (has('.env.example') || has('.env.sample')) hits.push('Env template (`.env.example`)');
  if (has('CLAUDE.md') || has('AGENTS.md')) hits.push('Existing sibling agent doc');
  if (has('README.md')) hits.push('README.md');
  return { hits, buildCmds: dedupe(buildCmds), testCmds: dedupe(testCmds) };
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function renderTemplate(signals: ReturnType<typeof detectRepoSignals>, projectName: string): string {
  const { hits, buildCmds, testCmds } = signals;
  const buildSection = buildCmds.length > 0
    ? buildCmds.map((c) => `- Build / dev: \`${c}\``).join('\n')
    : '- Build / dev: _(fill in — e.g. `npm run build`, `cargo build`, `go build ./...`)_';
  const testSection = testCmds.length > 0
    ? testCmds.map((c) => `- Test: \`${c}\``).join('\n')
    : '- Test: _(fill in)_';
  const signalsSection = hits.length > 0
    ? hits.map((h) => `- ${h}`).join('\n')
    : '- _(no signals detected — fill in stack manually)_';

  return `# AGENT.md

> Instructions for AI coding agents working in this repo. Compatible with AGENT.md / AGENTS.md aware tools.

## Project context

**${projectName}** — describe what this project is and the high-level architecture in 2-3 sentences.

## Detected project signals

${signalsSection}

## Build, test, run

${buildSection}
${testSection}

## Conventions

- Code style: _(describe — formatter, lint config)_
- Testing: _(unit/integration patterns)_
- Commits: conventional commits (\`feat\`, \`fix\`, \`chore\`, ...)

## Boundaries

- Always do: run tests before claiming work is complete; cite memory record ids when used.
- Ask first: schema migrations, dependency upgrades, anything that touches secrets.
- Never do: commit \`.env\` or anything matching \`*.key\`, modify \`vendor/\`, skip git hooks.

## Skill hints

If you have catalogued BrainRouter skills relevant to this repo, list them here:

- ${"`code-review-and-quality`"} — use before merging.
- ${"`agentic-engineering-workflow`"} — use for /feature-dev.
`;
}

const TEMPLATE_FALLBACK = `# AGENT.md

> Instructions for AI coding agents working in this repo. Compatible with AGENT.md / AGENTS.md aware tools.

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
 * We use AGENT.md (singular) as the canonical name — most AGENT-md aware tools
 * read both spellings, so a singular file works everywhere.
 */
export function initAgentMd(workspaceRoot: string): InitResult {
  const candidates = ['AGENT.md', 'AGENTS.md'].map((name) => path.join(workspaceRoot, name));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { status: 'exists', path: candidate };
    }
  }
  const target = candidates[0];
  const projectName = path.basename(workspaceRoot);
  const signals = detectRepoSignals(workspaceRoot);
  const body = signals.hits.length > 0 ? renderTemplate(signals, projectName) : TEMPLATE_FALLBACK;
  fs.writeFileSync(target, body, 'utf8');
  return { status: 'created', path: target };
}
