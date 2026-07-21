import fs from 'node:fs';
import path from 'node:path';
import {
  readWorkspaceFileBounded,
  writeWorkspaceFileAtomic,
  type WorkspaceFileStagedVersion,
} from '@kinqs/brainrouter-core/workspace';

const REPO_SIGNAL_MAX_BYTES = 256 * 1024;

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

  const hasFile = (rel: string) => safeWorkspaceEntryKind(root, rel) === 'file';
  const hasDirectory = (rel: string) => safeWorkspaceEntryKind(root, rel) === 'directory';
  const read = (rel: string): string | undefined => {
    try {
      return readWorkspaceFileBounded(root, rel, REPO_SIGNAL_MAX_BYTES).toString('utf8');
    } catch {
      return undefined;
    }
  };

  if (hasFile('package.json')) {
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
  if (hasFile('pnpm-workspace.yaml') || hasFile('pnpm-lock.yaml')) hits.push('pnpm');
  if (hasFile('yarn.lock')) hits.push('yarn');
  if (hasFile('tsconfig.json')) hits.push('TypeScript (`tsconfig.json`)');
  if (hasFile('go.mod')) {
    hits.push('Go (`go.mod`)');
    buildCmds.push('go build ./...');
    testCmds.push('go test ./...');
  }
  if (hasFile('Cargo.toml')) {
    hits.push('Rust (`Cargo.toml`)');
    buildCmds.push('cargo build');
    testCmds.push('cargo test');
  }
  if (hasFile('pyproject.toml') || hasFile('requirements.txt') || hasFile('setup.py')) {
    hits.push('Python');
    if (hasFile('pytest.ini') || (read('pyproject.toml') ?? '').includes('pytest')) {
      testCmds.push('pytest');
    }
  }
  if (hasFile('Gemfile')) hits.push('Ruby (`Gemfile`)');
  if (hasFile('Dockerfile')) hits.push('Docker (`Dockerfile`)');
  if (hasFile('docker-compose.yml') || hasFile('docker-compose.yaml') || hasFile('compose.yaml')) hits.push('Docker Compose');
  if (hasDirectory('.github/workflows')) hits.push('GitHub Actions CI');
  if (hasFile('.gitlab-ci.yml')) hits.push('GitLab CI');
  if (hasFile('Makefile')) {
    hits.push('Makefile');
    buildCmds.push('make');
    testCmds.push('make test');
  }
  if (hasFile('.env.example') || hasFile('.env.sample')) hits.push('Env template (`.env.example`)');
  if (hasFile('CLAUDE.md') || hasFile('AGENTS.md') || hasFile('AGENT.md')) hits.push('Existing sibling agent doc');
  if (hasFile('README.md')) hits.push('README.md');
  return { hits, buildCmds: dedupe(buildCmds), testCmds: dedupe(testCmds) };
}

function safeWorkspaceEntryKind(
  workspaceRoot: string,
  relativePath: string,
): 'file' | 'directory' | undefined {
  try {
    const root = fs.realpathSync(workspaceRoot);
    const segments = relativePath.split('/');
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (!segment || segment === '.' || segment === '..') return undefined;
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return undefined;
      if (index < segments.length - 1 && !stat.isDirectory()) return undefined;
      if (index === segments.length - 1) {
        if (stat.isFile()) return 'file';
        if (stat.isDirectory()) return 'directory';
      }
    }
  } catch {
    // Signal detection is advisory; unsafe, missing, or unreadable inputs are ignored.
  }
  return undefined;
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

> Instructions for AI coding agents working in this repo. Compatible with AGENT.md/ AGENTS.md / CLAUDE.md aware tools.

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

## Agent discipline (defaults)

- Default to writing NO code comments. Only add one when the WHY is non-obvious — a hidden constraint, subtle invariant, or workaround for a specific bug. Don't explain WHAT the code does; well-named identifiers cover that.
- Don't add features, refactors, or abstractions beyond what was asked. Three similar lines beats a premature abstraction.
- Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).
- Read before editing. Run tests after changes. Verify a task actually works before reporting it complete.
- Use \`file_path:line_number\` references when pointing at code so the user can jump to it.

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

> Instructions for AI coding agents working in this repo. Compatible with AGENT.md/ AGENTS.md / CLAUDE.md aware tools.

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

## Agent discipline (defaults)

- Default to writing NO code comments. Only add one when the WHY is non-obvious.
- Don't add features, refactors, or abstractions beyond what was asked.
- Don't add error handling for scenarios that can't happen. Validate only at system boundaries.
- Read before editing. Run tests after changes. Verify a task actually works before reporting complete.
- Use \`file_path:line_number\` references when pointing at code.

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

export interface InitAgentMdOptions {
  /** Additional validation/test hook run at the atomic commit boundary. */
  beforeCommit?: () => void;
  /** Durable staged-file identity used by the onboarding pair coordinator. */
  onStaged?: (staged: WorkspaceFileStagedVersion) => void;
}

export type PreparedAgentMd =
  | { status: 'created'; path: string; contents: string }
  | { status: 'exists'; path: string };

/** Build the exact deterministic instruction write without mutating the workspace. */
export function prepareAgentMd(workspaceRoot: string): PreparedAgentMd {
  const candidates = ['AGENT.md', 'AGENTS.md', 'CLAUDE.md'].map((name) => path.join(workspaceRoot, name));
  for (const candidate of candidates) {
    let stat: fs.Stats | undefined;
    try { stat = fs.lstatSync(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Unsafe project instruction path: ${candidate}`);
      }
      return { status: 'exists', path: candidate };
    }
  }
  const target = candidates[0];
  const projectName = path.basename(workspaceRoot);
  const signals = detectRepoSignals(workspaceRoot);
  const contents = signals.hits.length > 0 ? renderTemplate(signals, projectName) : TEMPLATE_FALLBACK;
  return { status: 'created', path: target, contents };
}

/**
 * Create AGENT.md in the workspace root if neither AGENT.md nor AGENTS.md is
 * already present. Idempotent: returns { status: 'exists' } when something
 * already lives there.
 *
 * We use AGENT.md (singular) as the canonical name — most AGENT-md aware tools
 * read both spellings, so a singular file works everywhere.
 */
export function initAgentMd(
  workspaceRoot: string,
  options: InitAgentMdOptions = {},
): InitResult {
  const prepared = prepareAgentMd(workspaceRoot);
  if (prepared.status === 'exists') return prepared;
  const written = writeWorkspaceFileAtomic(workspaceRoot, 'AGENT.md', prepared.contents, {
    beforeCommit: options.beforeCommit,
    onStaged: options.onStaged,
    exclusive: true,
  });
  return { status: 'created', path: written };
}
