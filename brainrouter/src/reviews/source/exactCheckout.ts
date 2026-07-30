import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { PrepareAssuranceSourceInput, PrepareAssuranceSourceResult } from '@kinqs/brainrouter-types/review';
import type { AssuranceOperationCancellation, RepositoryAssuranceSourcePort } from '@kinqs/brainrouter-core/review';
import { inventorySourceTree, parseGitTreeEntries, type SourceInventoryLimits } from './inventory.js';
import { NodeGitProcess, type GitProcess, type GitProcessOptions } from './gitProcess.js';

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface RepositoryCheckoutAccess {
  remoteUrl: string;
  authorizationHeader?: string;
}

export interface ExactCheckoutHandle {
  checkoutRef: string;
  eligiblePaths: string[];
  revisionSha: string;
}

export interface ExactCheckoutOptions {
  resolveAccess(input: PrepareAssuranceSourceInput): Promise<RepositoryCheckoutAccess>;
  git?: GitProcess;
  tempRoot?: string;
  inventoryLimits?: Partial<SourceInventoryLimits>;
  now?: () => string;
  nextId?: () => string;
}

export class ExactCheckoutCanceledError extends Error {
  constructor() {
    super('Repository source preparation was canceled.');
    this.name = 'ExactCheckoutCanceledError';
  }
}

function safeEnvironment(home: string, hooksPath: string): NodeJS.ProcessEnv {
  const inherited = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of inherited) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {
    ...env,
    HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksPath,
    GIT_CONFIG_KEY_1: 'protocol.allow',
    GIT_CONFIG_VALUE_1: 'never',
    GIT_CONFIG_KEY_2: 'protocol.https.allow',
    GIT_CONFIG_VALUE_2: 'always',
    GIT_CONFIG_KEY_3: 'protocol.file.allow',
    GIT_CONFIG_VALUE_3: 'always',
    GIT_CONFIG_KEY_4: 'http.followRedirects',
    GIT_CONFIG_VALUE_4: 'false',
  };
}

function fetchEnvironment(base: NodeJS.ProcessEnv, authorizationHeader: string | undefined): NodeJS.ProcessEnv {
  if (!authorizationHeader) return base;
  return {
    ...base,
    GIT_CONFIG_COUNT: '6',
    GIT_CONFIG_KEY_5: 'http.extraHeader',
    GIT_CONFIG_VALUE_5: authorizationHeader,
  };
}

function assertSafeAccess(
  access: RepositoryCheckoutAccess,
  forge: PrepareAssuranceSourceInput['repository']['forge'],
): void {
  if (!access.remoteUrl.trim()) throw new Error('Repository checkout URL is required.');
  if (/[\r\n\0]/.test(access.remoteUrl)) {
    throw new Error('Repository checkout URL contains invalid characters.');
  }
  if (
    access.authorizationHeader &&
    (/[\r\n\0]/.test(access.authorizationHeader) || !/^Authorization:\s*\S.+$/i.test(access.authorizationHeader))
  ) {
    throw new Error('Repository checkout authorization header is invalid.');
  }
  if (forge === 'local') {
    if (!isAbsolute(access.remoteUrl) && !access.remoteUrl.startsWith('file://')) {
      throw new Error('Local repository checkout requires an absolute path or file URL.');
    }
    if (access.authorizationHeader) {
      throw new Error('Local repository checkout must not include authorization.');
    }
    return;
  }
  const url = new URL(access.remoteUrl);
  if (url.protocol !== 'https:') {
    throw new Error('Remote repository checkout requires HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Repository checkout URL must not contain credentials.');
  }
}

function gitFailureCode(args: string[]): string {
  const operation = ['fetch', 'rev-parse', 'checkout', 'ls-tree', 'init'].find((name) => args.includes(name));
  return `GIT_${(operation ?? 'COMMAND').replace('-', '_').toUpperCase()}_FAILED`;
}

async function canceled(cancellation: AssuranceOperationCancellation | undefined): Promise<boolean> {
  return Boolean(await cancellation?.isCancellationRequested());
}

export class ExactShaCheckoutAdapter implements RepositoryAssuranceSourcePort {
  private readonly git: GitProcess;
  private readonly tempRoot: string;
  private readonly limits: SourceInventoryLimits;
  private readonly now: () => string;
  private readonly nextId: () => string;
  private readonly handles = new Map<
    string,
    ExactCheckoutHandle & { cleanupRoot: string; sourceRoot: string; eligiblePathSet: Set<string> }
  >();

  constructor(private readonly options: ExactCheckoutOptions) {
    this.git = options.git ?? new NodeGitProcess();
    this.tempRoot = options.tempRoot ?? join(tmpdir(), 'brainrouter-assurance');
    this.limits = {
      maxFiles: options.inventoryLimits?.maxFiles ?? 20_000,
      maxBytes: options.inventoryLimits?.maxBytes ?? 128 * 1024 * 1024,
    };
    if (
      !Number.isInteger(this.limits.maxFiles) ||
      this.limits.maxFiles < 1 ||
      !Number.isInteger(this.limits.maxBytes) ||
      this.limits.maxBytes < 1
    ) {
      throw new Error('Repository source inventory limits must be positive integers.');
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.nextId = options.nextId ?? (() => randomUUID());
  }

  resolve(checkoutRef: string): ExactCheckoutHandle | null {
    const handle = this.handles.get(checkoutRef);
    if (!handle) return null;
    return {
      checkoutRef: handle.checkoutRef,
      eligiblePaths: [...handle.eligiblePaths],
      revisionSha: handle.revisionSha,
    };
  }

  async readEligibleTextFile(checkoutRef: string, relativePath: string, maxBytes: number): Promise<string> {
    const handle = this.handles.get(checkoutRef);
    if (!handle) throw new Error('Exact source checkout is unavailable.');
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Exact source read limit must be a positive integer.');
    }
    if (!handle.eligiblePathSet.has(relativePath)) {
      throw new Error('Requested source path is not eligible for reading.');
    }
    const candidate = join(handle.sourceRoot, relativePath);
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const file = await open(candidate, constants.O_RDONLY | noFollow);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new Error('Requested source path is not a regular file.');
      if (metadata.size > maxBytes) throw new Error('Requested source path exceeds the read limit.');
      return file.readFile('utf8');
    } finally {
      await file.close();
    }
  }

  async prepare(
    input: PrepareAssuranceSourceInput,
    cancellation?: AssuranceOperationCancellation,
  ): Promise<PrepareAssuranceSourceResult> {
    if (!SHA_PATTERN.test(input.revision.headSha)) {
      throw new Error('Repository assurance requires a full exact head SHA.');
    }
    if (await canceled(cancellation)) throw new ExactCheckoutCanceledError();

    const access = await this.options.resolveAccess(input);
    assertSafeAccess(access, input.repository.forge);
    const createdAt = this.now();
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const cleanupRoot = await mkdtemp(join(this.tempRoot, 'checkout-'));
    const repositoryRoot = join(cleanupRoot, 'repository.git');
    const sourceRoot = join(cleanupRoot, 'source');
    const hooksPath = join(cleanupRoot, 'disabled-hooks');
    const home = join(cleanupRoot, 'home');
    await Promise.all([
      mkdir(sourceRoot, { recursive: true, mode: 0o700 }),
      mkdir(hooksPath, { recursive: true, mode: 0o700 }),
      mkdir(home, { recursive: true, mode: 0o700 }),
    ]);
    const baseEnv = safeEnvironment(home, hooksPath);

    const run = async (args: string[], options: Partial<GitProcessOptions> = {}): Promise<string> => {
      const result = await this.git.run(args, {
        cwd: cleanupRoot,
        env: options.env ?? baseEnv,
        maxBuffer: options.maxBuffer,
        timeoutMs: options.timeoutMs,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Repository source preparation failed: ${gitFailureCode(args)}`);
      }
      return result.stdout;
    };

    try {
      await run(['init', '--bare', repositoryRoot]);
      await run(
        [
          '--git-dir',
          repositoryRoot,
          'fetch',
          '--force',
          '--no-tags',
          '--no-recurse-submodules',
          '--depth=1',
          '--',
          access.remoteUrl,
          input.revision.headSha,
        ],
        {
          env: fetchEnvironment(baseEnv, access.authorizationHeader),
          timeoutMs: 300_000,
        },
      );
      if (await canceled(cancellation)) throw new ExactCheckoutCanceledError();

      const resolvedHead = (await run(['--git-dir', repositoryRoot, 'rev-parse', 'FETCH_HEAD^{commit}']))
        .trim()
        .toLowerCase();
      if (resolvedHead !== input.revision.headSha.toLowerCase()) {
        throw new Error('Repository checkout did not resolve to the requested exact head SHA.');
      }

      await run([
        '--git-dir',
        repositoryRoot,
        '--work-tree',
        sourceRoot,
        'checkout',
        '--force',
        resolvedHead,
        '--',
        '.',
      ]);
      if (await canceled(cancellation)) throw new ExactCheckoutCanceledError();

      const treeOutput = await run(['--git-dir', repositoryRoot, 'ls-tree', '-r', '-z', '--long', resolvedHead], {
        maxBuffer: 64 * 1024 * 1024,
      });
      const inventory = await inventorySourceTree(sourceRoot, parseGitTreeEntries(treeOutput), this.limits);
      if (await canceled(cancellation)) throw new ExactCheckoutCanceledError();

      const checkoutRef = `checkout:${this.nextId()}`;
      const inventoryRef = `inventory:${this.nextId()}`;
      this.handles.set(checkoutRef, {
        checkoutRef,
        sourceRoot,
        eligiblePaths: inventory.eligiblePaths,
        eligiblePathSet: new Set(inventory.eligiblePaths),
        revisionSha: resolvedHead,
        cleanupRoot,
      });
      const completedAt = this.now();
      return {
        source: {
          id: `source:${this.nextId()}`,
          revision: { ...input.revision },
          status: inventory.limitations.length ? 'partial' : 'ready',
          checkoutRef,
          inventoryRef,
          fileCount: inventory.fileCount,
          textFileCount: inventory.textFileCount,
          indexedFileCount: 0,
          unsupportedFileCount: inventory.unsupportedFileCount,
          byteCount: inventory.byteCount,
          createdAt,
          completedAt,
        },
        limitations: inventory.limitations,
      };
    } catch (error) {
      await rm(cleanupRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async release(checkoutRef: string): Promise<void> {
    const handle = this.handles.get(checkoutRef);
    if (!handle) return;
    this.handles.delete(checkoutRef);
    await rm(handle.cleanupRoot, { recursive: true, force: true });
  }
}
