// Side-effect module: imported FIRST in src/index.ts so it sets process.env
// from the right .env file BEFORE any other module evaluates and tries to
// read those vars.
//
// Priority order (first hit wins):
//   1. $BRAINROUTER_ENV_FILE              (explicit user override)
//   2. ~/.config/brainrouter/server.env   (canonical user location — the
//                                          one a globally-installed
//                                          `npm i -g @kinqs/brainrouter-mcp-server`
//                                          user should write to)
//   3. ./.env                              (cwd — matches dotenv default,
//                                          keeps monorepo dev working)
//
// The third entry matches dotenv's classic behavior, so existing
// `cd brainrouter/ && npm run start:http` workflows keep loading
// `brainrouter/.env` exactly as before. The first two are the additions
// that fix the global-install UX (users no longer need to cd anywhere
// special).

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function resolveEnvFile(): string | null {
  const candidates = [
    process.env.BRAINROUTER_ENV_FILE,
    path.join(os.homedir(), '.config', 'brainrouter', 'server.env'),
    path.join(process.cwd(), '.env'),
  ].filter(Boolean) as string[];

  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const envFile = resolveEnvFile();
if (envFile) {
  const result = dotenv.config({ path: envFile });
  const count = Object.keys(result.parsed ?? {}).length;
  process.stderr.write(`env: loaded ${count} var${count === 1 ? '' : 's'} from ${envFile}\n`);
} else {
  process.stderr.write(
    `env: no .env file found — looked at:\n` +
    `  $BRAINROUTER_ENV_FILE  (${process.env.BRAINROUTER_ENV_FILE ? 'set, but missing' : 'unset'})\n` +
    `  ~/.config/brainrouter/server.env\n` +
    `  ${path.join(process.cwd(), '.env')}\n` +
    `Run 'brainrouter-mcp init' to scaffold one (or set BRAINROUTER_LLM_API_KEY and friends in your shell).\n`
  );
}
