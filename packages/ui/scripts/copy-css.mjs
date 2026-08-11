/**
 * ADR-038 — copy the two curated stylesheets beside their compiled entrypoints.
 * TypeScript deliberately ignores CSS, while package exports must point only at
 * build output so both Vite and Next consume the same artifact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const surface of ['planner', 'notes']) {
  const destination = path.join(packageRoot, 'dist', surface);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(
    path.join(packageRoot, 'src', surface, `${surface}.css`),
    path.join(destination, `${surface}.css`),
  );
}
