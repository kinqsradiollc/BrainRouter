/**
 * Sync the bundled STARTER skills from the monorepo source of truth (skills/)
 * into the packages that ship them (`brainrouter-cli/skills`,
 * `packages/core/skills`), mirroring how packs/ ship as identical copies.
 *
 * WHY: the CLI resolves bundled skills through the installed
 * `@kinqs/brainrouter-mcp-server` package; a CLI-only or desktop install has no
 * bundled skills at all, so `/init` and the onboarding flow would ship without
 * their workflow skills. The starter set below travels with our own packages.
 *
 * `skills/` remains the ONLY place these files are edited. Run this after
 * changing a starter skill; the bundled-skills parity test fails CI on drift.
 *
 *   node scripts/sync-bundled-skills.mjs          # copy
 *   node scripts/sync-bundled-skills.mjs --check  # verify only (exit 1 on drift)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STARTER_SKILLS = [
  'agent/bootstrap-skill',
  'agent/planning-skill',
  'agent/spec-driven-skill',
  'agent/adr-skill',
  'agent/debugging-and-error-recovery',
  'agent/handover-skill',
  'api/testing-skill',
  'codebase/conventions-skill',
  'codebase/code-review-and-quality',
  'lifecycle/incremental-skill',
  'lifecycle/shipping-skill',
  'lifecycle/changelog-generator',
  'qa/verify-loop',
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTS = [path.join(repoRoot, 'brainrouter-cli', 'skills'), path.join(repoRoot, 'packages', 'core', 'skills')];
const checkOnly = process.argv.includes('--check');

let drift = 0;
for (const skill of STARTER_SKILLS) {
  const source = path.join(repoRoot, 'skills', skill, 'SKILL.md');
  if (!fs.existsSync(source)) {
    console.error(`missing source skill: skills/${skill}/SKILL.md`);
    process.exit(1);
  }
  const body = fs.readFileSync(source, 'utf8');
  for (const dest of DESTS) {
    const target = path.join(dest, skill, 'SKILL.md');
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === body) continue;
    drift += 1;
    if (checkOnly) {
      console.error(`drift: ${path.relative(repoRoot, target)} differs from skills/${skill}/SKILL.md`);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, 'utf8');
      console.log(`synced ${path.relative(repoRoot, target)}`);
    }
  }
}

if (checkOnly && drift > 0) {
  console.error(`\n${drift} bundled skill file(s) out of sync — run: node scripts/sync-bundled-skills.mjs`);
  process.exit(1);
}
console.log(checkOnly ? 'bundled skills in sync' : `done (${drift} file(s) written)`);
