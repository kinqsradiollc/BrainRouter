import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const MODULE_SPECIFIER = /(?:from\s+|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;

function nodeBuiltinImports(entry: URL): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  const offenders: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.href)) continue;
    visited.add(current.href);

    const source = fs.readFileSync(current, 'utf8');
    for (const match of source.matchAll(MODULE_SPECIFIER)) {
      const specifier = match[1]!;
      if (specifier.startsWith('node:')) {
        offenders.push(`${path.basename(current.pathname)} -> ${specifier}`);
      } else if (specifier.startsWith('.')) {
        pending.push(new URL(specifier, current));
      }
    }
  }

  return offenders.sort();
}

test('workspace capabilities public subpath has a browser-safe emitted import graph', () => {
  assert.deepEqual(
    nodeBuiltinImports(new URL('../workspace/capabilities.js', import.meta.url)),
    [],
    'renderer-facing Core entrypoints must not reach Node builtins',
  );
});
