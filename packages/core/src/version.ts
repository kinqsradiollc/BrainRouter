import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the CLI version.
 *
 * Read from this package's own `package.json` at module load so a release
 * bump is exactly one edit (`brainrouter-cli/package.json`). Previously the
 * banner read it locally while `mcpClient` hardcoded `0.3.8` — they drifted.
 * Now every surface (banner, MCP clientInfo) imports VERSION from here. The
 * try/catch degrades to a sentinel if path resolution ever changes.
 */
function readVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();
