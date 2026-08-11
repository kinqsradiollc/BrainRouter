import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrepareAssuranceSourceInput } from '@kinqs/brainrouter-types/review';
import { ExactCheckoutCanceledError, ExactShaCheckoutAdapter } from './exactCheckout.js';
import type { GitProcess, GitProcessOptions, GitProcessResult } from './gitProcess.js';

const roots: string[] = [];

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
}

async function localRepository(): Promise<{ path: string; headSha: string }> {
  const path = await temporaryRoot('assurance-repository');
  git(path, ['init']);
  git(path, ['config', 'user.email', 'test@example.invalid']);
  git(path, ['config', 'user.name', 'Checkout Test']);
  await mkdir(join(path, 'src'));
  await writeFile(join(path, 'src', 'handler.ts'), 'export const handler = () => "ok";\n');
  await writeFile(join(path, 'README.md'), '# fixture\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-m', 'fixture']);
  return { path, headSha: git(path, ['rev-parse', 'HEAD']) };
}

function input(headSha: string): PrepareAssuranceSourceInput {
  return {
    runId: 'run-1',
    repository: { forge: 'local', slug: 'fixture' },
    revision: { headSha },
  };
}

function remoteInput(headSha: string): PrepareAssuranceSourceInput {
  return {
    runId: 'run-1',
    repository: { forge: 'github', slug: 'owner/repository' },
    revision: { headSha },
  };
}

class RecordingGitProcess implements GitProcess {
  readonly calls: Array<{ args: string[]; options: GitProcessOptions }> = [];

  constructor(private readonly responder: (args: string[], options: GitProcessOptions) => GitProcessResult) {}

  async run(args: string[], options: GitProcessOptions): Promise<GitProcessResult> {
    this.calls.push({ args: [...args], options: { ...options, env: { ...options.env } } });
    return this.responder(args, options);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ExactShaCheckoutAdapter', () => {
  it('materializes and releases an exact local revision without repository metadata', async () => {
    const repository = await localRepository();
    const tempRoot = await temporaryRoot('assurance-checkouts');
    const adapter = new ExactShaCheckoutAdapter({
      tempRoot,
      resolveAccess: async () => ({ remoteUrl: repository.path }),
      nextId: (() => {
        let id = 0;
        return () => String(++id);
      })(),
    });

    const result = await adapter.prepare(input(repository.headSha));
    expect(result.source.status).toBe('ready');
    expect(result.source.revision.headSha).toBe(repository.headSha);
    expect(result.source.fileCount).toBe(2);
    expect(result.source.textFileCount).toBe(2);
    expect(result.source.unsupportedFileCount).toBe(0);
    expect(result.limitations).toEqual([]);

    const handle = adapter.resolve(result.source.checkoutRef!);
    expect(handle?.revisionSha).toBe(repository.headSha);
    expect(handle?.eligiblePaths).toEqual(['README.md', 'src/handler.ts']);
    const [checkoutDirectory] = await readdir(tempRoot);
    const sourceRoot = join(tempRoot, checkoutDirectory, 'source');
    await expect(stat(join(sourceRoot, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(adapter.readEligibleTextFile(result.source.checkoutRef!, 'src/handler.ts', 1_000)).resolves.toContain(
      'handler',
    );
    await expect(adapter.readEligibleTextFile(result.source.checkoutRef!, '../outside', 1_000)).rejects.toThrow(
      'not eligible',
    );
    await expect(adapter.readEligibleTextFile(result.source.checkoutRef!, 'src/handler.ts', 1)).rejects.toThrow(
      'read limit',
    );

    await adapter.release(result.source.checkoutRef!);
    expect(adapter.resolve(result.source.checkoutRef!)).toBeNull();
    await expect(stat(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('records bounded inventory as partial instead of claiming full coverage', async () => {
    const repository = await localRepository();
    const adapter = new ExactShaCheckoutAdapter({
      tempRoot: await temporaryRoot('assurance-checkouts'),
      resolveAccess: async () => ({ remoteUrl: repository.path }),
      inventoryLimits: { maxFiles: 1, maxBytes: 1_000_000 },
    });

    const result = await adapter.prepare(input(repository.headSha));
    expect(result.source.status).toBe('partial');
    expect(result.source.fileCount).toBe(2);
    expect(result.source.textFileCount).toBe(1);
    expect(result.limitations).toEqual([
      expect.objectContaining({ reasonCode: 'SOURCE_FILE_LIMIT', state: 'partial' }),
    ]);
    await adapter.release(result.source.checkoutRef!);
  }, 15_000);

  it('scopes authorization to fetch and disables prompts, hooks, and unsafe protocols', async () => {
    let cancellationChecks = 0;
    const process = new RecordingGitProcess((args) => ({
      exitCode: 0,
      stdout: args.includes('fetch') ? '' : '',
      stderr: '',
    }));
    const tempRoot = await temporaryRoot('assurance-checkouts');
    const adapter = new ExactShaCheckoutAdapter({
      tempRoot,
      git: process,
      resolveAccess: async () => ({
        remoteUrl: 'https://example.invalid/owner/repository.git',
        authorizationHeader: 'Authorization: Bearer super-secret',
      }),
    });

    await expect(
      adapter.prepare(remoteInput('a'.repeat(40)), {
        isCancellationRequested: () => {
          cancellationChecks += 1;
          return cancellationChecks >= 2;
        },
      }),
    ).rejects.toBeInstanceOf(ExactCheckoutCanceledError);

    const fetch = process.calls.find((call) => call.args.includes('fetch'))!;
    const nonFetch = process.calls.filter((call) => !call.args.includes('fetch'));
    expect(fetch.args).toEqual(expect.arrayContaining(['--no-tags', '--no-recurse-submodules', '--depth=1']));
    expect(fetch.options.env.GIT_CONFIG_VALUE_5).toBe('Authorization: Bearer super-secret');
    expect(nonFetch.every((call) => call.options.env.GIT_CONFIG_VALUE_5 === undefined)).toBe(true);
    for (const call of process.calls) {
      expect(call.options.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(call.options.env.GIT_CONFIG_VALUE_0).toContain('disabled-hooks');
      expect(call.options.env.GIT_CONFIG_VALUE_1).toBe('never');
      expect(call.options.env.GIT_CONFIG_VALUE_4).toBe('false');
      expect(call.args.join(' ')).not.toContain('super-secret');
      expect(call.args).not.toContain('submodule');
    }
    await expect(stat(tempRoot)).resolves.toBeDefined();
    expect(await readFileNames(tempRoot)).toEqual([]);
  });

  it('cleans failed checkouts and redacts fetch credentials from errors', async () => {
    const process = new RecordingGitProcess((args) =>
      args.includes('fetch')
        ? {
            exitCode: 1,
            stdout: '',
            stderr: 'Authorization: Bearer super-secret rejected; super-secret invalid',
          }
        : { exitCode: 0, stdout: '', stderr: '' },
    );
    const tempRoot = await temporaryRoot('assurance-checkouts');
    const adapter = new ExactShaCheckoutAdapter({
      tempRoot,
      git: process,
      resolveAccess: async () => ({
        remoteUrl: 'https://example.invalid/owner/repository.git',
        authorizationHeader: 'Authorization: Bearer super-secret',
      }),
    });

    const error = await adapter.prepare(remoteInput('a'.repeat(40))).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('super-secret');
    expect(String(error)).toContain('GIT_FETCH_FAILED');
    expect(await readFileNames(tempRoot)).toEqual([]);
  });

  it('fails closed and cleans up when fetch resolves a different commit', async () => {
    const process = new RecordingGitProcess((args) => ({
      exitCode: 0,
      stdout: args.includes('rev-parse') ? `${'b'.repeat(40)}\n` : '',
      stderr: '',
    }));
    const tempRoot = await temporaryRoot('assurance-checkouts');
    const adapter = new ExactShaCheckoutAdapter({
      tempRoot,
      git: process,
      resolveAccess: async () => ({
        remoteUrl: 'https://example.invalid/owner/repository.git',
      }),
    });

    await expect(adapter.prepare(remoteInput('a'.repeat(40)))).rejects.toThrow('requested exact head SHA');
    expect(await readFileNames(tempRoot)).toEqual([]);
  });

  it('rejects remote credential URLs and non-HTTPS forge transports before git runs', async () => {
    const process = new RecordingGitProcess(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    const adapter = new ExactShaCheckoutAdapter({
      tempRoot: await temporaryRoot('assurance-checkouts'),
      git: process,
      resolveAccess: vi.fn(async () => ({
        remoteUrl: 'ssh://user@example.invalid/owner/repository.git',
      })),
    });
    const remoteInput: PrepareAssuranceSourceInput = {
      runId: 'run-1',
      repository: { forge: 'github', slug: 'owner/repository' },
      revision: { headSha: 'a'.repeat(40) },
    };

    await expect(adapter.prepare(remoteInput)).rejects.toThrow('requires HTTPS');
    expect(process.calls).toHaveLength(0);
  });
});

async function readFileNames(path: string): Promise<string[]> {
  return readdir(path);
}
