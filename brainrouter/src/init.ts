// Side-effect module: imported FIRST in src/index.ts (before env-loader).
//
// Handles the `brainrouter-mcp init` subcommand by scaffolding a user-editable
// .env file at ~/.config/brainrouter/server.env from the package's bundled
// .env.example, then exiting. Never returns control when invoked.
//
// This solves the global-install UX gap: a user who runs
// `npm install -g @kinqs/brainrouter-mcp-server` has no obvious place to put
// their LLM credentials. `brainrouter-mcp init` creates the file in a known
// user-writable location that env-loader.ts then auto-finds.
//
// If the file already exists, init prints the path so the user knows where
// to edit it — but does NOT overwrite (don't clobber a user's real config).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

function runInit(): void {
  const userConfigDir = path.join(os.homedir(), '.config', 'brainrouter');
  const userEnvFile = path.join(userConfigDir, 'server.env');

  // .env.example sits at the package root (one level above src/ in source,
  // one level above dist/ after build, both layouts work in the installed
  // tarball because the `files` allowlist in package.json includes it).
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const exampleCandidates = [
    path.resolve(here, '..', '.env.example'),       // dist/init.js → ../.env.example
    path.resolve(here, '..', '..', '.env.example'), // src/init.ts (dev) → ../../.env.example
  ];
  const examplePath = exampleCandidates.find((p) => fs.existsSync(p));

  if (!examplePath) {
    process.stderr.write(
      `init: couldn't find .env.example bundled with the package.\n` +
      `Checked:\n${exampleCandidates.map((p) => `  ${p}`).join('\n')}\n` +
      `This is a packaging bug — please file an issue at ` +
      `https://github.com/kinqsradiollc/BrainRouter/issues\n`
    );
    process.exit(1);
  }

  if (fs.existsSync(userEnvFile)) {
    process.stdout.write(
      `init: ${userEnvFile} already exists — not overwriting.\n` +
      `Edit it with: $EDITOR ${userEnvFile}\n` +
      `(Or compare against the latest template at ${examplePath})\n`
    );
    process.exit(0);
  }

  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.copyFileSync(examplePath, userEnvFile);
  // Tighten perms — this file will hold API keys + a JWT secret.
  try { fs.chmodSync(userEnvFile, 0o600); } catch { /* best effort */ }

  process.stdout.write(
    `init: created ${userEnvFile}\n` +
    `\n` +
    `Next steps:\n` +
    `  1. Edit it:                 $EDITOR ${userEnvFile}\n` +
    `  2. Set BRAINROUTER_LLM_API_KEY (required for cognitive extraction)\n` +
    `  3. Change BRAINROUTER_ADMIN_PASSWORD and BRAINROUTER_JWT_SECRET\n` +
    `  4. Start the server:        brainrouter-mcp --http --port 3747\n` +
    `\n` +
    `The server auto-finds this file via ~/.config/brainrouter/server.env\n` +
    `(or set BRAINROUTER_ENV_FILE=/some/other/path to override).\n`
  );
  process.exit(0);
}

if (process.argv.includes('init')) {
  runInit();
}
