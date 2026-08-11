/**
 * Approval classifier for dynamically discovered MCP tools.
 *
 * Tool names are only warning evidence: a call bypasses host approval solely
 * when its annotations explicitly and consistently prove read-only behavior.
 */

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
 * Classify MCP calls before dispatch.
 *
 * MCP tools are open-ended: some are read-only (`search`, `get`, `list`), while
 * others mutate remote systems (`create_issue`, `send_message`, `delete_file`).
 * Only an explicit, non-contradictory read-only annotation bypasses the generic
 * host approval path. Names and descriptions can strengthen the warning, but
 * their silence can never prove that an open-ended remote tool is non-mutating.
 */
export function assessMcpToolApproval(name: string, toolSpec?: any): McpToolApprovalAssessment {
  const annotations = toolSpec?.annotations ?? toolSpec?.inputSchema?.annotations;
  const destructive = annotationFlag(annotations, 'destructiveHint', 'destructive_hint');
  const openWorld = annotationFlag(annotations, 'openWorldHint', 'open_world_hint');
  const readOnly = annotationFlag(annotations, 'readOnlyHint', 'read_only_hint');
  const title = String(toolSpec?.title ?? toolSpec?.description ?? '');
  const bare = bareMcpToolName(name, toolSpec);
  const haystack = `${bare} ${title}`.toLowerCase();

  // Annotation that explicitly says "destructive" is the strongest signal.
  if (destructive === true) {
    return {
      requiresApproval: true,
      dangerous: true,
      reason: 'MCP tool is marked destructive by its annotations',
    };
  }

  // Name/description checks for destructive + network/egress actions run BEFORE
  // we trust a `readOnlyHint`: a tool NAMED `delete_*` / `transfer_*` that also
  // advertises read-only is contradictory, and a rogue or mis-configured server
  // could set readOnlyHint=true to slip a mutating/egress call past the gate.
  // (The softer "mutating" check below still yields to an explicit read-only
  // hint, since verbs like "update" appear in benign read names.)
  if (/(^|[_\-\s])(delete|remove|destroy|drop|wipe|truncate|reset|revoke|disable|archive|purge|terminate|kill)([_\-\s]|$)/.test(haystack)) {
    return {
      requiresApproval: true,
      dangerous: true,
      reason: 'MCP tool name/description looks destructive',
    };
  }
  // Network / open-world egress: data leaves the machine or reaches third
  // parties. Un-gated, a silent child could exfiltrate or trigger side effects.
  if (/(^|[_\-\s])(broadcast|notify|sync|replicate|transfer|subscribe|publish|export|upload|webhook|email|sms|message|payment|charge|http|fetch|request|crawl|scrape|browse|navigate)([_\-\s]|$)/.test(haystack)) {
    return {
      requiresApproval: true,
      dangerous: false,
      reason: 'MCP tool name/description looks like a network / open-world action',
    };
  }
  // Open-world annotation (e.g. a web/search tool reaching arbitrary hosts):
  // require approval unless the server ALSO marks it read-only.
  if (openWorld === true && readOnly !== true) {
    return {
      requiresApproval: true,
      dangerous: false,
      reason: 'MCP tool is marked open-world and not read-only',
    };
  }

  // Only now is a read-only hint trusted — the clearly-dangerous name patterns
  // above have already been ruled out.
  if (readOnly === true) {
    return {
      requiresApproval: false,
      dangerous: false,
      reason: 'MCP tool is marked read-only',
    };
  }

  if (/(^|[_\-\s])(create|update|edit|write|apply|patch|send|post|merge|commit|push|deploy|install|invite|approve|close|resolve|set|rename|move|grant|assign)([_\-\s]|$)/.test(haystack)) {
    return {
      requiresApproval: true,
      dangerous: false,
      reason: 'MCP tool name/description looks mutating',
    };
  }

  return {
    requiresApproval: true,
    dangerous: false,
    reason: 'MCP tool did not provide an explicit trusted read-only annotation',
  };
}
