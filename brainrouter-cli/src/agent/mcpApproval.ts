export interface McpToolApprovalAssessment {
  requiresApproval: boolean;
  dangerous: boolean;
  reason: string;
}

function annotationFlag(annotations: any, camel: string, snake: string): boolean | undefined {
  if (!annotations || typeof annotations !== 'object') return undefined;
  const raw = annotations[camel] ?? annotations[snake];
  return typeof raw === 'boolean' ? raw : undefined;
}

function bareMcpToolName(name: string, toolSpec?: any): string {
  const raw = toolSpec?.__rawName;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (!name.startsWith('mcp_')) return name;
  const rest = name.slice('mcp_'.length);
  const first = rest.indexOf('_');
  return first >= 0 ? rest.slice(first + 1) : name;
}

/**
 * CODEX-MCP-APPROVAL — classify MCP calls before dispatch.
 *
 * MCP tools are open-ended: some are read-only (`search`, `get`, `list`), while
 * others mutate remote systems (`create_issue`, `send_message`, `delete_file`).
 * Codex routes MCP approval requests through a typed guardian path. BrainRouter
 * does not have that full host protocol yet, so this classifier gives the agent
 * a fail-closed boundary for clearly mutating or open-world MCP calls.
 */
export function assessMcpToolApproval(name: string, toolSpec?: any): McpToolApprovalAssessment {
  const annotations = toolSpec?.annotations ?? toolSpec?.inputSchema?.annotations;
  const destructive = annotationFlag(annotations, 'destructiveHint', 'destructive_hint');
  const openWorld = annotationFlag(annotations, 'openWorldHint', 'open_world_hint');
  const readOnly = annotationFlag(annotations, 'readOnlyHint', 'read_only_hint');
  const title = String(toolSpec?.title ?? toolSpec?.description ?? '');
  const bare = bareMcpToolName(name, toolSpec);
  const haystack = `${bare} ${title}`.toLowerCase();

  if (destructive === true) {
    return {
      requiresApproval: true,
      dangerous: true,
      reason: 'MCP tool is marked destructive by its annotations',
    };
  }
  if (openWorld === true && readOnly !== true) {
    return {
      requiresApproval: true,
      dangerous: false,
      reason: 'MCP tool is marked open-world and not read-only',
    };
  }
  if (readOnly === true) {
    return {
      requiresApproval: false,
      dangerous: false,
      reason: 'MCP tool is marked read-only',
    };
  }

  if (/(^|[_\-\s])(delete|remove|destroy|drop|wipe|truncate|reset|revoke|disable|archive)([_\-\s]|$)/.test(haystack)) {
    return {
      requiresApproval: true,
      dangerous: true,
      reason: 'MCP tool name/description looks destructive',
    };
  }
  if (/(^|[_\-\s])(create|update|edit|write|apply|patch|send|post|publish|merge|commit|push|deploy|install|upload|invite|approve|close|resolve)([_\-\s]|$)/.test(haystack)) {
    return {
      requiresApproval: true,
      dangerous: false,
      reason: 'MCP tool name/description looks mutating',
    };
  }

  return {
    requiresApproval: false,
    dangerous: false,
    reason: 'MCP tool did not advertise mutating behavior',
  };
}
