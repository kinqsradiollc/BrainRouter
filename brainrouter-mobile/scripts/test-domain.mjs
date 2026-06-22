// Cross-platform runner for the ported domain unit tests.
// `node --test` only supports glob patterns on Node >= 21; this repo's tooling
// runs on Node 20, where `tsx --test "src/domain/**/*.test.ts"` does not expand.
// So we discover the *.test.ts files ourselves and hand the explicit list to tsx.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'src/domain';
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith('.test.ts')) files.push(p);
  }
})(ROOT);

if (files.length === 0) {
  console.error(`No *.test.ts files found under ${ROOT}/`);
  process.exit(1);
}

const res = spawnSync('tsx', ['--test', ...files], { stdio: 'inherit', shell: true });
process.exit(res.status ?? 1);
