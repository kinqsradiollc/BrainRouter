export type AgentAdapterId = 'brainrouter' | 'claude-code' | 'codex' | 'opencode' | 'gemini-cli';

export type HostedAgentStatus = 'idle' | 'needs-trust' | 'starting' | 'working' | 'blocked' | 'waiting' | 'done' | 'failed';

export interface AgentAdapter {
  id: AgentAdapterId;
  label: string;
  command: string;
  aliases: string[];
  interactiveArgs: string[];
  resumeArgs: (sessionId: string) => string[];
  requiresWorkspaceTrust: boolean;
  controls: { interrupt: string; approve: string; submit: string };
  statusPatterns: Partial<Record<'blocked' | 'waiting' | 'done' | 'failed', RegExp[]>>;
  integration: {
    mcp?: { command: string; args: string[] };
    hookEvents: string[];
  };
}

export interface AdapterLaunchPlan {
  ok: boolean;
  adapter: AgentAdapter;
  executable?: string;
  args?: string[];
  initialInput?: string;
  reuseKey?: string;
  status: HostedAgentStatus;
  error?: 'trust-required' | 'not-installed';
}

export interface AdapterDetection {
  id: AgentAdapterId;
  installed: boolean;
  executable?: string;
}

export interface HostedAgentHookEvent {
  adapterId: AgentAdapterId;
  event: string;
  sessionId?: string;
  message?: string;
  exitCode?: number;
}
