import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the MCP server version.
 *
 * Read from this package's own `package.json` at module load so a release
 * bump is exactly one edit (`brainrouter/package.json`) and the value can
 * never silently drift — the hardcoded `serverInfo.version` had rotted to
 * `0.3.8` while the package was at 0.4.x. The try/catch degrades to a
 * sentinel if path resolution ever changes; package.json ships alongside
 * `dist/` for both the source checkout and the published tarball.
 */
function readVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
