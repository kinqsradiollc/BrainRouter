export interface BackgroundShellProcess {
  readonly pid: number | null;
  readonly logPath: string;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: () => void): void;
  closeLog(): void;
}

export interface BackgroundShellLogRead {
  size: number;
  bytes: Uint8Array;
}

export interface BackgroundShellHost {
  createId(): string;
  now(): number;
  start(input: {
    id: string;
    command: string;
    cwd: string;
    workspaceRoot: string;
  }): BackgroundShellProcess;
  readLog(logPath: string, fromByte: number, maxBytes: number): BackgroundShellLogRead;
  killProcessTree(pid: number, signal: NodeJS.Signals): void;
  onExit(listener: () => void): void;
}
