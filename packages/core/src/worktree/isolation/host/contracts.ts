export interface WorktreeGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface WorktreeIsolationHost {
  realpath(value: string): string;
  mkdir(value: string): void;
  exists(value: string): boolean;
  writeText(file: string, value: string): void;
  readDirectory(value: string): string[];
  removeTree(value: string): void;
  runGit(cwd: string, args: string[]): WorktreeGitResult;
  findGitRoot(value: string): string | null;
  configuredWorktreeRoot(): string | undefined;
  brainrouterHome(): string;
  stateDir(workspaceRoot: string): string;
  now(): number;
}
