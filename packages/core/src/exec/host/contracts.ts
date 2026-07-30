export interface HostCommandPlan {
  executable: string;
  args: string[];
  cwd?: string;
}

export interface HostCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status?: number;
}

export interface HostCommandExecutor {
  run(plan: HostCommandPlan, timeout: number): HostCommandResult;
}
