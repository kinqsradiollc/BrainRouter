import { randomUUID } from 'node:crypto';
import type {
  AssuranceCodeIndexReceipt,
  AssuranceCodeIndexResult,
  AssuranceCoverageLimitation,
  UpdateAssuranceIndexInput,
} from '@kinqs/brainrouter-types/review';
import type { AssuranceOperationCancellation, RepositoryAssuranceIndexPort } from '@kinqs/brainrouter-core/review';
import ts from 'typescript';
import type { CheckoutIndexResolver, ParserBackedIndexHandle } from './graphTypes.js';
import { isTypeScriptSourcePath } from './pathResolution.js';
import { buildTypeScriptGraph } from './typeScriptGraph.js';

export interface TypeScriptIndexOptions {
  checkouts: CheckoutIndexResolver;
  maxFileBytes?: number;
  maxSymbols?: number;
  maxRelationships?: number;
  now?: () => string;
  nextId?: () => string;
}

export class ParserIndexCanceledError extends Error {
  constructor() {
    super('Repository parser indexing was canceled.');
    this.name = 'ParserIndexCanceledError';
  }
}

async function canceled(cancellation: AssuranceOperationCancellation | undefined): Promise<boolean> {
  return Boolean(await cancellation?.isCancellationRequested());
}

function limitation(
  id: string,
  state: AssuranceCoverageLimitation['state'],
  reasonCode: string,
  summary: string,
  affectedPaths: string[],
  affectedLanguages?: string[],
): AssuranceCoverageLimitation {
  return {
    id,
    component: 'typescript-parser-index',
    state,
    reasonCode,
    summary,
    ...(affectedPaths.length ? { affectedPaths: affectedPaths.slice(0, 100) } : {}),
    ...(affectedLanguages?.length ? { affectedLanguages } : {}),
  };
}

function unsupportedLanguage(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return extension || 'unknown';
}

export class TypeScriptAssuranceIndexAdapter implements RepositoryAssuranceIndexPort {
  private readonly maxFileBytes: number;
  private readonly maxSymbols: number;
  private readonly maxRelationships: number;
  private readonly now: () => string;
  private readonly nextId: () => string;
  private readonly indexes = new Map<string, ParserBackedIndexHandle>();

  constructor(private readonly options: TypeScriptIndexOptions) {
    this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    this.maxSymbols = options.maxSymbols ?? 200_000;
    this.maxRelationships = options.maxRelationships ?? 500_000;
    if (
      !Number.isInteger(this.maxFileBytes) ||
      this.maxFileBytes < 1 ||
      !Number.isInteger(this.maxSymbols) ||
      this.maxSymbols < 1 ||
      !Number.isInteger(this.maxRelationships) ||
      this.maxRelationships < 1
    ) {
      throw new Error('Parser index limits must be positive integers.');
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.nextId = options.nextId ?? (() => randomUUID());
  }

  resolve(indexRef: string): ParserBackedIndexHandle | null {
    const handle = this.indexes.get(indexRef);
    return handle ? structuredClone(handle) : null;
  }

  async update(
    input: UpdateAssuranceIndexInput,
    cancellation?: AssuranceOperationCancellation,
  ): Promise<AssuranceCodeIndexResult> {
    if (await canceled(cancellation)) throw new ParserIndexCanceledError();
    const checkout = this.options.checkouts.resolve(input.checkoutRef);
    if (!checkout) throw new Error('Exact source checkout is unavailable for indexing.');
    if (checkout.revisionSha !== input.revision.headSha) {
      throw new Error('Parser index checkout revision must match the run head revision.');
    }

    const createdAt = this.now();
    const supportedPaths = checkout.eligiblePaths.filter(isTypeScriptSourcePath);
    const unsupportedPaths = checkout.eligiblePaths.filter((path) => !isTypeScriptSourcePath(path));
    const oversizedPaths: string[] = [];
    const unreadablePaths: string[] = [];
    const files: Array<{ path: string; source: string }> = [];
    for (const path of supportedPaths) {
      if (await canceled(cancellation)) throw new ParserIndexCanceledError();
      try {
        files.push({
          path,
          source: await this.options.checkouts.readEligibleTextFile(input.checkoutRef, path, this.maxFileBytes),
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('read limit')) {
          oversizedPaths.push(path);
        } else {
          unreadablePaths.push(path);
        }
      }
    }

    const graph = buildTypeScriptGraph({
      files,
      eligiblePaths: new Set(supportedPaths),
      maxSymbols: this.maxSymbols,
      maxRelationships: this.maxRelationships,
    });
    if (await canceled(cancellation)) throw new ParserIndexCanceledError();
    const limitations: AssuranceCoverageLimitation[] = [];
    if (unsupportedPaths.length) {
      limitations.push(
        limitation(
          'index-unsupported-languages',
          'unsupported',
          'INDEX_LANGUAGE_UNSUPPORTED',
          `${unsupportedPaths.length} text files use unsupported parser languages.`,
          unsupportedPaths,
          [...new Set(unsupportedPaths.map(unsupportedLanguage))].sort(),
        ),
      );
    }
    if (oversizedPaths.length) {
      limitations.push(
        limitation(
          'index-file-size-limit',
          'partial',
          'INDEX_FILE_SIZE_LIMIT',
          `${oversizedPaths.length} parser-eligible files exceed the per-file byte limit.`,
          oversizedPaths,
        ),
      );
    }
    if (unreadablePaths.length) {
      limitations.push(
        limitation(
          'index-source-unavailable',
          'unavailable',
          'INDEX_SOURCE_UNAVAILABLE',
          `${unreadablePaths.length} parser-eligible files could not be read.`,
          unreadablePaths,
        ),
      );
    }
    if (graph.parseFailedPaths.length) {
      limitations.push(
        limitation(
          'index-parse-failed',
          'failed',
          'INDEX_PARSE_FAILED',
          `${graph.parseFailedPaths.length} files contain parser diagnostics.`,
          graph.parseFailedPaths,
        ),
      );
    }
    if (graph.unresolvedImportPaths.length) {
      limitations.push(
        limitation(
          'index-import-unresolved',
          'partial',
          'INDEX_IMPORT_UNRESOLVED',
          `${graph.unresolvedImportPaths.length} relative imports could not be resolved inside the exact checkout.`,
          graph.unresolvedImportPaths,
        ),
      );
    }
    if (graph.symbolLimitReached) {
      limitations.push(
        limitation(
          'index-symbol-limit',
          'partial',
          'INDEX_SYMBOL_LIMIT',
          `Parser output reached the ${this.maxSymbols}-symbol limit.`,
          [],
        ),
      );
    }
    if (graph.relationshipLimitReached) {
      limitations.push(
        limitation(
          'index-relationship-limit',
          'partial',
          'INDEX_RELATIONSHIP_LIMIT',
          `Parser output reached the ${this.maxRelationships}-relationship limit.`,
          [],
        ),
      );
    }

    const indexRef = `index:${this.nextId()}`;
    const completedAt = this.now();
    const failed = supportedPaths.length > 0 && files.length === 0;
    const receipt: AssuranceCodeIndexReceipt = {
      id: `index-receipt:${this.nextId()}`,
      revisionSha: input.revision.headSha,
      indexRef,
      status: failed ? 'failed' : limitations.length ? 'partial' : 'ready',
      analyzerId: 'typescript-parser-index',
      analyzerVersion: ts.version,
      supportedLanguages: ['typescript', 'javascript'],
      filesEligible: supportedPaths.length,
      filesIndexed: files.length,
      symbolsIndexed: graph.symbols.length,
      relationshipsIndexed: graph.relationships.length,
      limitationIds: limitations.map((item) => item.id),
      createdAt,
      completedAt,
      ...(failed ? { errorCode: 'INDEX_NO_FILES_PARSED' } : {}),
    };
    this.indexes.set(indexRef, {
      indexRef,
      revisionSha: input.revision.headSha,
      receipt,
      symbols: graph.symbols,
      relationships: graph.relationships,
      limitations,
    });
    return { receipt, limitations };
  }

  async release(indexRef: string): Promise<void> {
    this.indexes.delete(indexRef);
  }
}
