import { describe, expect, it } from 'vitest';
import { generatedSourceRelationships } from './generatedSourceRelationships.js';

describe('generated source relationships', () => {
  it('maps exact inventory outputs through JSONC rootDir and outDir', () => {
    const eligible = new Set([
      'desktop/tsconfig.electron.json',
      'desktop/electron/host.ts',
      'desktop/electron/host.test.ts',
      'desktop/dist-electron/host.js',
      'desktop/dist-electron/host.test.js',
      'desktop/dist-electron/unmapped.js',
    ]);
    expect(generatedSourceRelationships([
      {
        path: 'desktop/tsconfig.electron.json',
        source: '{ "compilerOptions": { "rootDir": "electron", "outDir": "dist-electron" /* exact */ } }',
      },
    ], eligible)).toEqual([
      ['desktop/electron/host.ts', 'desktop/dist-electron/host.js'],
      ['desktop/electron/host.test.ts', 'desktop/dist-electron/host.test.js'],
    ]);
  });

  it('fails closed for malformed, escaping, and ambiguous mappings', () => {
    const eligible = new Set([
      'tsconfig.json',
      'nested/tsconfig.json',
      'src/a.ts',
      'nested/src/a.ts',
      'dist/a.js',
    ]);
    expect(generatedSourceRelationships([
      { path: 'tsconfig.json', source: '{ malformed' },
      { path: 'nested/tsconfig.json', source: '{"compilerOptions":{"rootDir":"../../outside","outDir":"../dist"}}' },
    ], eligible)).toEqual([]);

    expect(generatedSourceRelationships([
      { path: 'tsconfig.json', source: '{"compilerOptions":{"rootDir":"src","outDir":"dist"}}' },
      { path: 'nested/tsconfig.json', source: '{"compilerOptions":{"rootDir":"src","outDir":"../dist"}}' },
    ], eligible)).toEqual([]);
  });
});
