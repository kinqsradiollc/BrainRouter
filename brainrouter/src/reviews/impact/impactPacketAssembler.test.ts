import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssembleAssuranceImpactPacketsInput } from '@kinqs/brainrouter-types/review';
import { validateAssuranceImpactPacketAssembly } from '@kinqs/brainrouter-core/review';
import type { CheckoutIndexHandle, CheckoutIndexResolver } from '../index/graphTypes.js';
import { TypeScriptAssuranceIndexAdapter } from '../index/typeScriptIndex.js';
import { DeterministicImpactPacketAssembler, ImpactPacketAssemblyCanceledError } from './impactPacketAssembler.js';

const revisionSha = 'a'.repeat(40);
const roots: string[] = [];

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

interface FixtureCheckout extends CheckoutIndexHandle {
  sourceRoot: string;
}

async function fixtureCheckout(): Promise<FixtureCheckout> {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'impact-packet-fixture-'));
  roots.push(sourceRoot);
  const files: Record<string, string> = {
    'src/source.ts': 'export function readInput(value: string) { return value.trim(); }\n',
    'src/service.ts': [
      "import { readInput } from './source.js';",
      'export function transform(value: string) { return readInput(value); }',
    ].join('\n'),
    'src/sink.ts': 'export function writeOutput(value: string) { return value; }\n',
    'src/schema.ts': ["import { z } from 'zod';", 'export const schema = z.string();'].join('\n'),
    'src/route.ts': [
      "import { transform } from './service.js';",
      "import { writeOutput } from './sink.js';",
      "import { schema } from './schema.js';",
      "const privateKey = 'SECRET';",
      'export function route(value: string) {',
      '  schema;',
      '  return writeOutput(transform(value + privateKey));',
      '}',
    ].join('\n'),
    'config/routes.config.ts': ["import { route } from '../src/route.js';", 'export const routes = [route];'].join(
      '\n',
    ),
    'tests/route.test.ts': ["import { route } from '../src/route.js';", "test('route', () => route(' value '));"].join(
      '\n',
    ),
  };
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), source);
  }
  return {
    checkoutRef: 'checkout-1',
    sourceRoot,
    eligiblePaths: Object.keys(files).sort(),
    revisionSha,
  };
}

function checkoutResolver(fixture: FixtureCheckout): CheckoutIndexResolver {
  return {
    resolve: (checkoutRef) =>
      checkoutRef === fixture.checkoutRef
        ? {
            checkoutRef,
            eligiblePaths: [...fixture.eligiblePaths],
            revisionSha: fixture.revisionSha,
          }
        : null,
    readEligibleTextFile: async (checkoutRef, relativePath, maxBytes) => {
      if (checkoutRef !== fixture.checkoutRef || !fixture.eligiblePaths.includes(relativePath)) {
        throw new Error('source unavailable');
      }
      const path = join(fixture.sourceRoot, relativePath);
      const metadata = await stat(path);
      if (metadata.size > maxBytes) throw new Error('read limit');
      return readFile(path, 'utf8');
    },
  };
}

function indexInput() {
  return {
    runId: 'run-1',
    repository: { forge: 'github' as const, slug: 'owner/repository' },
    revision: { headSha: revisionSha },
    checkoutRef: 'checkout-1',
  };
}

function packetInput(indexRef: string): AssembleAssuranceImpactPacketsInput {
  return {
    runId: 'run-1',
    repository: { forge: 'github', slug: 'owner/repository' },
    revision: { headSha: revisionSha },
    program: 'security_review',
    checkoutRef: 'checkout-1',
    indexRef,
    changed: [{ path: 'src/route.ts', line: 4, symbol: 'route' }],
    redactionPolicyId: 'redact-test',
    limits: {
      maxPackets: 4,
      maxPacketBytes: 32_000,
      maxFilesPerPacket: 8,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DeterministicImpactPacketAssembler', () => {
  it('assembles bounded caller/callee/config/test and source-to-sink evidence', async () => {
    const fixture = await fixtureCheckout();
    const checkouts = checkoutResolver(fixture);
    const indexes = new TypeScriptAssuranceIndexAdapter({
      checkouts,
      now: () => '2026-07-29T00:00:00.000Z',
      nextId: () => 'index-1',
    });
    const index = await indexes.update(indexInput());
    const assembler = new DeterministicImpactPacketAssembler({
      indexes,
      checkouts,
      redact: ({ content }) => content.replaceAll('SECRET', '[REDACTED]'),
      now: () => '2026-07-29T00:00:01.000Z',
    });

    const assembly = await assembler.assemble(packetInput(index.receipt.indexRef));
    const validation = validateAssuranceImpactPacketAssembly(
      assembly,
      { headSha: revisionSha },
      {
        id: 'policy-1',
        policyHash: 'sha256:policy',
        organizationId: 'org-1',
        program: 'security_review',
        analyzers: [],
        packetLimits: {
          maxPackets: 4,
          maxPacketBytes: 32_000,
          maxFilesPerPacket: 8,
        },
        budgets: { maxModelCalls: 4, maxToolCalls: 8, maxDurationMs: 60_000 },
        redactionPolicyId: 'redact-test',
        publicationPolicyId: 'publish-test',
        inlineFindingsEnabled: false,
        blockingEnabled: true,
        createdAt: '2026-07-29T00:00:00.000Z',
      },
    );
    expect(validation).toEqual({ ok: true, issues: [] });
    expect(assembly.packets).toHaveLength(1);
    expect(assembly.limitations).toEqual([]);
    const packet = assembly.packets[0];
    expect(packet.truncated).toBe(false);
    expect(packet.byteCount).toBeLessThanOrEqual(32_000);
    expect(packet.context.map((item) => item.relationship)).toEqual(
      expect.arrayContaining(['callee', 'configuration', 'test', 'dependency', 'source_to_sink']),
    );
    expect(packet.sourceToSinkPaths).toEqual([
      expect.objectContaining({
        mechanism: 'call_path',
        source: expect.objectContaining({ symbol: 'readInput' }),
        sink: expect.objectContaining({ symbol: 'writeOutput' }),
      }),
    ]);
    const evidenceIds = new Set(packet.context.map((item) => item.evidence.id));
    expect(packet.sourceToSinkPaths[0].evidenceRefs.every((ref) => evidenceIds.has(ref))).toBe(true);
    const routeArtifact = packet.artifactRefs
      .map((ref) => assembler.resolveArtifact(ref))
      .find((artifact) => artifact?.path === 'src/route.ts');
    expect(routeArtifact?.content).toContain('[REDACTED]');
    expect(routeArtifact?.content).not.toContain('SECRET');
    assembler.releaseArtifacts(packet.artifactRefs);
    expect(
      packet.artifactRefs.every((ref) => assembler.resolveArtifact(ref) === null),
    ).toBe(true);
  });

  it('is stable across retries and records file/byte limits instead of overfilling', async () => {
    const fixture = await fixtureCheckout();
    const checkouts = checkoutResolver(fixture);
    const indexes = new TypeScriptAssuranceIndexAdapter({
      checkouts,
      nextId: () => 'index-1',
      now: () => '2026-07-29T00:00:00.000Z',
    });
    const index = await indexes.update(indexInput());
    const assembler = new DeterministicImpactPacketAssembler({
      indexes,
      checkouts,
      redact: ({ content }) => content,
      now: () => '2026-07-29T00:00:01.000Z',
    });
    const input = packetInput(index.receipt.indexRef);
    input.limits.maxFilesPerPacket = 1;
    input.limits.maxPacketBytes = 80;

    const first = await assembler.assemble(input);
    const second = await assembler.assemble(input);
    expect(second).toEqual(first);
    expect(first.packets[0].truncated).toBe(true);
    expect(first.packets[0].byteCount).toBeLessThanOrEqual(80);
    expect(first.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode: 'IMPACT_PACKET_FILE_LIMIT' }),
        expect.objectContaining({ reasonCode: 'IMPACT_PACKET_BYTE_LIMIT' }),
      ]),
    );
    expect(new Set(first.limitations.map((item) => item.id))).toEqual(new Set(first.packets[0].limitationIds));
  });

  it('fails closed on stale inputs, missing redaction, and cancellation', async () => {
    const fixture = await fixtureCheckout();
    const checkouts = checkoutResolver(fixture);
    const indexes = new TypeScriptAssuranceIndexAdapter({ checkouts });
    const index = await indexes.update(indexInput());
    const assembler = new DeterministicImpactPacketAssembler({
      indexes,
      checkouts,
      redact: ({ content }) => content,
    });
    const input = packetInput(index.receipt.indexRef);

    await expect(assembler.assemble(input, { isCancellationRequested: () => true })).rejects.toBeInstanceOf(
      ImpactPacketAssemblyCanceledError,
    );
    await expect(assembler.assemble({ ...input, redactionPolicyId: '' })).rejects.toThrow('redaction policy');
    await expect(
      assembler.assemble({
        ...input,
        revision: { headSha: 'b'.repeat(40) },
      }),
    ).rejects.toThrow('must match');

    let reads = 0;
    const guardedAssembler = new DeterministicImpactPacketAssembler({
      indexes,
      checkouts: {
        ...checkouts,
        readEligibleTextFile: async (...args) => {
          reads += 1;
          return checkouts.readEligibleTextFile(...args);
        },
      },
      redact: ({ content }) => content,
    });
    await expect(guardedAssembler.assemble({
      ...input,
      changed: [{ path: '../../../etc/passwd', line: 1 }],
    })).rejects.toThrow('exact source inventory');
    expect(reads).toBe(0);
  });

  it('does not retain artifacts when redaction fails', async () => {
    const fixture = await fixtureCheckout();
    const checkouts = checkoutResolver(fixture);
    const indexes = new TypeScriptAssuranceIndexAdapter({ checkouts });
    const index = await indexes.update(indexInput());
    const assembler = new DeterministicImpactPacketAssembler({
      indexes,
      checkouts,
      redact: () => {
        throw new Error('redactor unavailable with sensitive detail');
      },
    });
    const input = packetInput(index.receipt.indexRef);
    const packetKey = `${revisionSha}:security_review:src/route.ts:4:route`;
    const packetId = stableId('impact-packet', packetKey);
    const predictedRef = stableId('impact-artifact', `${packetId}:src/route.ts`);

    await expect(assembler.assemble(input)).rejects.toThrow('redaction failed');
    expect(assembler.resolveArtifact(predictedRef)).toBeNull();
  });
});
