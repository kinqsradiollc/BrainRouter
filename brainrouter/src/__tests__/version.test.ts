import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';

describe('version', () => {
  it('reads VERSION live from package.json (the MCP serverInfo single source)', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    // From src/__tests__/, ../../package.json === brainrouter/package.json.
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    // Guards the serverInfo.version that had rotted to 0.3.8 before centralizing.
    expect(VERSION).toBe(pkg.version);
  });
});
