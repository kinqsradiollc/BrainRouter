import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateAssuranceIndexInput } from '@kinqs/brainrouter-types/review';
import type { CheckoutIndexHandle, CheckoutIndexResolver } from './graphTypes.js';
import { ParserIndexCanceledError, TypeScriptAssuranceIndexAdapter } from './typeScriptIndex.js';

const roots: string[] = [];

interface FixtureCheckout extends CheckoutIndexHandle {
  sourceRoot: string;
}

async function fixture(files: Record<string, string>): Promise<FixtureCheckout> {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'assurance-parser-index-'));
  roots.push(sourceRoot);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), source);
  }
  return {
    checkoutRef: 'checkout-1',
    sourceRoot,
    eligiblePaths: Object.keys(files).sort(),
    revisionSha: 'a'.repeat(40),
  };
}

function resolver(handle: FixtureCheckout): CheckoutIndexResolver {
  return {
    resolve: (checkoutRef) =>
      checkoutRef === handle.checkoutRef
        ? {
            checkoutRef: handle.checkoutRef,
            eligiblePaths: [...handle.eligiblePaths],
            revisionSha: handle.revisionSha,
          }
        : null,
    readEligibleTextFile: async (checkoutRef, relativePath, maxBytes) => {
      if (checkoutRef !== handle.checkoutRef || !handle.eligiblePaths.includes(relativePath)) {
        throw new Error('source unavailable');
      }
      const path = join(handle.sourceRoot, relativePath);
      const metadata = await stat(path);
      if (metadata.size > maxBytes) throw new Error('read limit');
      return readFile(path, 'utf8');
    },
  };
}

function input(): UpdateAssuranceIndexInput {
  return {
    runId: 'run-1',
    repository: { forge: 'github', slug: 'owner/repository' },
    revision: { headSha: 'a'.repeat(40) },
    checkoutRef: 'checkout-1',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TypeScriptAssuranceIndexAdapter', () => {
  it('builds parser-backed cross-file call, import, inheritance, config, and test edges', async () => {
    const checkout = await fixture({
      'src/base.ts': 'export class Base {}\n',
      'src/source.ts': 'export function readInput(value: string) { return value.trim(); }\n',
      'src/service.ts': [
        "import { Base } from './base.js';",
        "import { readInput } from './source.js';",
        'export class Service extends Base {',
        '  run(value: string) { return readInput(value); }',
        '}',
        'export function transform(value: string) { return readInput(value); }',
      ].join('\n'),
      'src/sink.ts': 'export function writeOutput(value: string) { return value; }\n',
      'src/route.ts': [
        "import { transform } from './service.js';",
        "import { writeOutput } from './sink.js';",
        'export function route(value: string) {',
        '  return writeOutput(transform(value));',
        '}',
      ].join('\n'),
      'src/registry.ts': ["import { route } from './route.js';", 'export const registry = { route };'].join('\n'),
      'src/schema.ts': ["import { z } from 'zod';", 'export const schema = z.string();'].join('\n'),
      'config/routes.config.ts': ["import { route } from '../src/route.js';", 'export const routes = [route];'].join(
        '\n',
      ),
      'tests/route.test.ts': [
        "import { route } from '../src/route.js';",
        "test('route', () => route(' value '));",
      ].join('\n'),
    });
    const adapter = new TypeScriptAssuranceIndexAdapter({
      checkouts: resolver(checkout),
      nextId: (() => {
        let id = 0;
        return () => String(++id);
      })(),
    });

    const result = await adapter.update(input());
    expect(result.receipt.status).toBe('ready');
    expect(result.receipt.filesEligible).toBe(9);
    expect(result.receipt.filesIndexed).toBe(9);
    expect(result.receipt.analyzerVersion).toMatch(/^\d+\.\d+/);
    expect(result.limitations).toEqual([]);

    const graph = adapter.resolve(result.receipt.indexRef)!;
    const symbolByName = new Map(graph.symbols.map((symbol) => [symbol.name, symbol]));
    const edges = graph.relationships.map((edge) => ({
      relationship: edge.relationship,
      from: graph.symbols.find((symbol) => symbol.id === edge.fromSymbolId)?.name,
      to: graph.symbols.find((symbol) => symbol.id === edge.toSymbolId)?.name,
    }));
    expect(symbolByName.get('Service')?.kind).toBe('class');
    expect(symbolByName.get('Service.run')?.kind).toBe('method');
    expect(edges).toEqual(
      expect.arrayContaining([
        { relationship: 'extends', from: 'Service', to: 'Base' },
        { relationship: 'calls', from: 'Service.run', to: 'readInput' },
        { relationship: 'calls', from: 'transform', to: 'readInput' },
        { relationship: 'calls', from: 'route', to: 'transform' },
        { relationship: 'calls', from: 'route', to: 'writeOutput' },
        { relationship: 'references', from: 'registry', to: 'route' },
        { relationship: 'imports', from: 'z', to: 'zod' },
        { relationship: 'calls', from: 'schema', to: 'zod' },
        { relationship: 'configures', from: 'routes', to: 'route' },
        { relationship: 'tests', from: 'tests/route.test.ts', to: 'route' },
      ]),
    );

    await adapter.release(result.receipt.indexRef);
    expect(adapter.resolve(result.receipt.indexRef)).toBeNull();
  });

  it('reports unsupported, oversized, unreadable, and parse-failed source coverage', async () => {
    const checkout = await fixture({
      'README.md': '# unsupported\n',
      'src/large.ts': `export const large = '${'x'.repeat(100)}';\n`,
      'src/broken.ts': 'export function broken( {\n',
      'src/unresolved.ts': "import { missing } from './not-present.js';\nexport { missing };\n",
    });
    checkout.eligiblePaths.push('src/missing.ts');
    const adapter = new TypeScriptAssuranceIndexAdapter({
      checkouts: resolver(checkout),
      maxFileBytes: 90,
    });

    const result = await adapter.update(input());
    expect(result.receipt.status).toBe('partial');
    expect(result.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode: 'INDEX_LANGUAGE_UNSUPPORTED' }),
        expect.objectContaining({ reasonCode: 'INDEX_FILE_SIZE_LIMIT' }),
        expect.objectContaining({ reasonCode: 'INDEX_SOURCE_UNAVAILABLE' }),
        expect.objectContaining({ reasonCode: 'INDEX_PARSE_FAILED' }),
        expect.objectContaining({ reasonCode: 'INDEX_IMPORT_UNRESOLVED' }),
      ]),
    );
    expect(result.receipt.limitationIds).toEqual(result.limitations.map((limitation) => limitation.id));
  });

  it('rejects stale and missing checkout handles before parsing', async () => {
    const checkout = await fixture({ 'src/index.ts': 'export const value = 1;\n' });
    const stale = new TypeScriptAssuranceIndexAdapter({
      checkouts: resolver({ ...checkout, revisionSha: 'b'.repeat(40) }),
    });
    await expect(stale.update(input())).rejects.toThrow('must match');

    const missing = new TypeScriptAssuranceIndexAdapter({
      checkouts: {
        resolve: () => null,
        readEligibleTextFile: async () => {
          throw new Error('source unavailable');
        },
      },
    });
    await expect(missing.update(input())).rejects.toThrow('unavailable');
  });

  it('honors cancellation before reading source files', async () => {
    const checkout = await fixture({ 'src/index.ts': 'export const value = 1;\n' });
    const adapter = new TypeScriptAssuranceIndexAdapter({
      checkouts: resolver(checkout),
    });

    await expect(adapter.update(input(), { isCancellationRequested: () => true })).rejects.toBeInstanceOf(
      ParserIndexCanceledError,
    );
  });
});
