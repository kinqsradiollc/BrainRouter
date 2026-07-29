import { execFile } from 'node:child_process';

export interface GitProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeoutMs?: number;
}

export interface GitProcess {
  run(args: string[], options: GitProcessOptions): Promise<GitProcessResult>;
}

export class NodeGitProcess implements GitProcess {
  constructor(private readonly executable = 'git') {}

  run(args: string[], options: GitProcessOptions): Promise<GitProcessResult> {
    return new Promise((resolve) => {
      execFile(
        this.executable,
        args,
        {
          cwd: options.cwd,
          env: options.env,
          encoding: 'utf8',
          maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
          timeout: options.timeoutMs ?? 120_000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode:
              typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
                ? Number((error as NodeJS.ErrnoException).code)
                : error
                  ? 1
                  : 0,
            stdout,
            stderr,
          });
        },
      );
    });
  }
}
