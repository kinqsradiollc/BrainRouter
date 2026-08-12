/**
 * Preflight for the Cloudflare build: every workspace dependency this app needs
 * must be RESOLVABLE from here before OpenNext runs.
 *
 * Why this exists rather than trusting the deploy doc: `@kinqs/brainrouter-ui`
 * is `"private": true` and is never published. An install rooted at
 * `brainrouter-dashboard/` therefore fails with `E404` — and every other shared
 * dep IS published, so that install mode worked right up until the shared
 * planner/notes surfaces landed. The failure arrives with a dependency, in a
 * hosted build, on a setting nobody changed.
 *
 * `npm error 404 Not Found - GET .../@kinqs%2fbrainrouter-ui` does not tell an
 * operator that the Root directory is wrong. This does.
 *
 * Invariant: run from `brainrouter-dashboard`, every `@kinqs/*` dependency
 * resolves. It asserts the CONDITION (can this build see its deps) rather than
 * the cause, so a future private package is covered without editing this file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const workspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@kinqs/'));

/**
 * Presence on disk, not importability.
 *
 * `require.resolve` is the wrong question here and gets this wrong in both
 * directions: a types-only package whose `exports` map has no `"."` entry is
 * fully installed and still fails to resolve — which is a false deploy failure,
 * exactly the kind of thing this script exists to prevent. What the Root
 * directory setting decides is whether npm PLACED the package, so that is what
 * is checked, walking up the way node's own resolution does.
 */
function installed(name) {
  let dir = here;
  for (;;) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

const missing = workspaceDeps.filter((name) => !installed(name));

if (missing.length) {
  console.error(`\n[cf-preflight] ${missing.length} workspace dependency(ies) are not installed for ${here}:`);
  for (const name of missing) console.error(`  - ${name}`);
  console.error(
    '\nThis is almost always the Cloudflare "Root directory" setting. It must be the\n' +
      'REPOSITORY ROOT, not brainrouter-dashboard: at least one of these packages is\n' +
      '"private": true and is never published to npm, so an install scoped to this\n' +
      'directory cannot resolve it.\n\n' +
      'See brainrouter-dashboard/DEPLOY-CLOUDFLARE.md for the settings table.\n',
  );
  process.exit(1);
}
