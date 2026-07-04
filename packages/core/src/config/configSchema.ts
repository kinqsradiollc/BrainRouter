export type ConfigSchemaFieldType = 'boolean' | 'number' | 'string' | 'select';
export type ConfigSchemaSection = 'modelLimits' | 'agents' | 'notifications';

export interface ConfigSchemaField {
  path: string;
  label: string;
  section: ConfigSchemaSection;
  type: ConfigSchemaFieldType;
  description: string;
  defaultValue: unknown;
  min?: number;
  max?: number;
  options?: string[];
}

export interface ConfigSchemaDescriptor {
  version: 1;
  root: 'cli';
  fields: ConfigSchemaField[];
}

export const CLI_CONFIG_SCHEMA: ConfigSchemaDescriptor = {
  version: 1,
  root: 'cli',
  fields: [
    {
      path: 'maxOutputTokens',
      label: 'Max output tokens',
      section: 'modelLimits',
      type: 'number',
      description: 'Completion-token cap per provider call. Clear to use the provider default.',
      defaultValue: null,
      min: 0,
    },
    {
      path: 'autoCompactTokens',
      label: 'Auto-compact threshold',
      section: 'modelLimits',
      type: 'number',
      description: 'Prompt-token threshold before history compaction starts.',
      defaultValue: 80_000,
      min: 1,
    },
    {
      path: 'maxToolLoops',
      label: 'Max tool loops',
      section: 'modelLimits',
      type: 'number',
      description: 'Hard cap on tool iterations per turn.',
      defaultValue: 250,
      min: 1,
    },
    {
      path: 'llmTimeoutMs',
      label: 'LLM timeout',
      section: 'modelLimits',
      type: 'number',
      description: 'Per-request timeout in milliseconds before retry or reconnect handling.',
      defaultValue: 120_000,
      min: 1,
    },
    {
      path: 'llmMaxConcurrent',
      label: 'Max concurrent LLM calls',
      section: 'modelLimits',
      type: 'number',
      description: 'Parallel in-flight LLM requests across the parent agent and children.',
      defaultValue: 4,
      min: 1,
    },
    {
      path: 'budget.maxPerTaskUSD',
      label: 'Max task budget USD',
      section: 'modelLimits',
      type: 'number',
      description: 'Per-task USD cap. 0 means uncapped.',
      defaultValue: 0,
      min: 0,
    },
    {
      path: 'budget.maxPerTaskTokens',
      label: 'Max task budget tokens',
      section: 'modelLimits',
      type: 'number',
      description: 'Per-task token cap. 0 means uncapped.',
      defaultValue: 0,
      min: 0,
    },
    {
      path: 'contextCompaction',
      label: 'Context compaction',
      section: 'modelLimits',
      type: 'boolean',
      description: 'Auto-summarize old history when the window fills.',
      defaultValue: true,
    },
    {
      path: 'nextActionPlanner',
      label: 'Next-action planner',
      section: 'agents',
      type: 'select',
      description: 'Plan the next step before acting.',
      defaultValue: 'on',
      options: ['on', 'off'],
    },
    {
      path: 'maxConcurrentChildren',
      label: 'Max concurrent children',
      section: 'agents',
      type: 'number',
      description: 'Parallel child-agent slots.',
      defaultValue: 8,
      min: 0,
    },
    {
      path: 'maxSpawnDepth',
      label: 'Max spawn depth',
      section: 'agents',
      type: 'number',
      description: 'How deep child agents may spawn child agents.',
      defaultValue: 3,
      min: 0,
    },
    {
      path: 'buildLoop',
      label: 'Build loop',
      section: 'agents',
      type: 'select',
      description: 'When implementation tasks may escalate into the build workflow.',
      defaultValue: 'escalate',
      options: ['off', 'escalate', 'always'],
    },
    {
      path: 'notifyBell',
      label: 'Notify bell',
      section: 'notifications',
      type: 'boolean',
      description: 'Ring the terminal bell on an idle background completion.',
      defaultValue: false,
    },
    {
      path: 'updateCheck',
      label: 'Update check',
      section: 'notifications',
      type: 'boolean',
      description: 'Check for new BrainRouter versions on launch.',
      defaultValue: true,
    },
  ],
};

export function configSchemaFields(section?: ConfigSchemaSection): ConfigSchemaField[] {
  return CLI_CONFIG_SCHEMA.fields.filter((field) => !section || field.section === section);
}

export function findConfigSchemaField(path: string): ConfigSchemaField | undefined {
  return CLI_CONFIG_SCHEMA.fields.find((field) => field.path === path);
}

export function getConfigValueAtPath(root: Record<string, unknown> | undefined, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setConfigValueAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (value === null) delete cur[leaf];
  else cur[leaf] = value;
}
