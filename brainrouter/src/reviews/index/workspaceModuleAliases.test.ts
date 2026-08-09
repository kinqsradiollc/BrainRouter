/**
 * ADR-033 D2/D9 — package aliases resolve only to inventoried source inside
 * the package that declared them.
 */

import { describe, expect, it } from 'vitest';
import { parseWorkspaceModuleAliases, resolveWorkspaceModule } from './workspaceModuleAliases.js';

describe('workspace module aliases', () => {
  it('maps exact and wildcard dist exports back to source modules', () => {
    const aliases = parseWorkspaceModuleAliases([
      {
        path: 'packages/shared/package.json',
        source: JSON.stringify({
          name: '@example/shared',
          exports: {
            './review': './dist/review/index.js',
            './features/*': './dist/features/*.js',
          },
        }),
      },
    ]);
    const eligible = new Set([
      'packages/shared/src/review/index.ts',
      'packages/shared/src/features/flags.ts',
    ]);

    expect(resolveWorkspaceModule('@example/shared/review', eligible, aliases))
      .toBe('packages/shared/src/review/index.ts');
    expect(resolveWorkspaceModule('@example/shared/features/flags', eligible, aliases))
      .toBe('packages/shared/src/features/flags.ts');
  });

  it('rejects malformed names and export targets that escape the package root', () => {
    const aliases = parseWorkspaceModuleAliases([
      {
        path: 'packages/shared/package.json',
        source: JSON.stringify({
          name: '@example/shared',
          exports: { './escape': '../../apps/consumer/src/secret.ts' },
        }),
      },
      { path: 'packages/bad/package.json', source: '{"name":"../../bad"}' },
      { path: 'packages/broken/package.json', source: '{not json' },
    ]);
    const eligible = new Set(['apps/consumer/src/secret.ts']);

    expect(aliases.map((alias) => alias.name)).toEqual(['@example/shared']);
    expect(resolveWorkspaceModule('@example/shared/escape', eligible, aliases)).toBeNull();
  });

  it('fails closed on duplicate package names and undeclared restricted subpaths', () => {
    const duplicate = parseWorkspaceModuleAliases([
      { path: 'packages/a/package.json', source: '{"name":"@example/duplicate"}' },
      { path: 'packages/b/package.json', source: '{"name":"@example/duplicate"}' },
    ]);
    expect(duplicate).toEqual([]);

    const restricted = parseWorkspaceModuleAliases([{
      path: 'packages/shared/package.json',
      source: JSON.stringify({ name: '@example/shared', exports: { './public': './src/public.ts' } }),
    }]);
    expect(resolveWorkspaceModule(
      '@example/shared/private',
      new Set(['packages/shared/src/private.ts']),
      restricted,
    )).toBeNull();
  });
});
