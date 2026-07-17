// Cross-platform runner for the ported domain unit tests.
// `node --test` only supports glob patterns on Node >= 21; this repo's tooling
// runs on Node 20, where `tsx --test "src/domain/**/*.test.ts"` does not expand.
// So we discover the *.test.ts files ourselves and hand the explicit list to tsx.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The pure, RN-free layers: the ported domain logic + the transport seam (the
// RemoteTransport client is testable with an injected fake WebSocket).
const ROOTS = ['src/domain', 'src/transport'];
const files = [];
for (const root of ROOTS) {
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.test.ts')) files.push(p);
    }
  })(root);
}

if (files.length === 0) {
  console.error(`No *.test.ts files found under ${ROOTS.join(', ')}`);
  process.exit(1);
}

const res = spawnSync('tsx', ['--test', ...files], { stdio: 'inherit', shell: true });
process.exit(res.status ?? 1);
