/**
 * CLI-10 (0.4.3) — project-profile detection for `/verify detect`.
 *
 * Pure: given the marker files present at a project root, return the matching
 * profile(s) and the verify recipe (build / test / lint) for each. A repo can
 * match several (a Vite web app is also Node). This is the foundation; running
 * the recipe in a matched sandbox + injecting post-edit LSP diagnostics is the
 * follow-up (needs a live toolchain to verify).
 */

export interface VerifyRecipe {
  build?: string;
  test?: string;
  lint?: string;
}

export interface ProjectProfile {
  name: 'node' | 'python' | 'rust' | 'web';
  /** The marker file that matched. */
  marker: string;
  recipe: VerifyRecipe;
}

// Ordered most-specific-first so the headline profile is the most informative.
const RULES: Array<{ name: ProjectProfile['name']; markers: string[]; recipe: VerifyRecipe }> = [
  { name: 'rust', markers: ['Cargo.toml'], recipe: { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy' } },
  { name: 'python', markers: ['pyproject.toml', 'requirements.txt', 'setup.py'], recipe: { test: 'pytest', lint: 'ruff check .' } },
  { name: 'web', markers: ['vite.config.ts', 'vite.config.js', 'index.html'], recipe: { build: 'npm run build' } },
  { name: 'node', markers: ['package.json'], recipe: { build: 'npm run build', test: 'npm test', lint: 'npm run lint' } },
];

/** Detect all matching profiles from the set of marker filenames present at the root. */
export function detectProjectProfile(presentFiles: readonly string[]): ProjectProfile[] {
  const present = new Set(presentFiles);
  const out: ProjectProfile[] = [];
  for (const rule of RULES) {
    const marker = rule.markers.find((m) => present.has(m));
    if (marker) out.push({ name: rule.name, marker, recipe: rule.recipe });
  }
  return out;
}

/** Render the detected profiles + recipes as plain lines (caller colours headers). */
export function formatProjectProfiles(profiles: ProjectProfile[]): string[] {
  if (profiles.length === 0) return ['No known project profile detected (looked for Cargo.toml / pyproject.toml / package.json / vite config).'];
  const lines: string[] = [`Detected: ${profiles.map((p) => p.name).join(', ')}`, ''];
  for (const p of profiles) {
    lines.push(`${p.name} (${p.marker})`);
    if (p.recipe.build) lines.push(`  build: ${p.recipe.build}`);
    if (p.recipe.test) lines.push(`  test:  ${p.recipe.test}`);
    if (p.recipe.lint) lines.push(`  lint:  ${p.recipe.lint}`);
  }
  return lines;
}
