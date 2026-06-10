import React from 'react';
import { Box, Text } from 'ink';
import type { ScrollbackEntry } from '../ChatApp.js';
import { GLYPH, groupTasksByKind, type BackgroundTask, type BackgroundTaskKind } from '../../../runtime/backgroundTasks.js';

interface SidebarProps {
  model?: string;
  session?: string;
  branch?: string;
  effort?: string;
  accessMode?: 'read' | 'write' | 'shell';
  workspaceRoot?: string;
  bgTasks?: BackgroundTask[];
  scrollback?: ScrollbackEntry[];
  mcpProfile?: string;
  mcpTransport?: string;
  mcpOnline?: boolean;
  mcpIdentity?: 'brainrouter' | 'third-party' | 'unknown';
  width?: number;
}

export function Sidebar({
  model = 'unknown-model',
  session = 'unknown-session',
  branch = 'unknown-branch',
  effort = 'low',
  accessMode = 'read',
  workspaceRoot = 'unknown-path',
  bgTasks = [],
  scrollback = [],
  mcpProfile = 'local-http',
  mcpOnline = false,
  mcpIdentity = 'unknown',
  width = 30,
}: SidebarProps) {
  // Extract active memories (last 3 items of kind 'memory')
  const memories = scrollback
    .filter((entry): entry is Extract<ScrollbackEntry, { kind: 'memory' }> => entry.kind === 'memory')
    .slice(-3);

  // Helper to truncate text to fit the sidebar width (roughly 30-35 cols)
  const truncate = (text: string, length: number = 24): string => {
    if (text.length <= length) return text;
    return text.substring(0, length - 3) + '...';
  };

  const getModeColor = (mode: string) => {
    if (mode === 'shell') return 'red';
    if (mode === 'write') return 'yellow';
    return 'green';
  };

  // Helper to extract parent path and active repository folder name
  const formatWorkspacePath = (p: string) => {
    try {
      const normalized = p.replace(/\\/g, '/');
      const parts = normalized.split('/');
      const base = parts.pop() || '';
      const parent = parts.join('/');
      
      // Truncate parent path but keep it recognizable
      let shortParent = parent;
      if (parent.length > 15) {
        shortParent = '...' + parent.substring(parent.length - 12);
      }
      return { parent: shortParent, base };
    } catch {
      return { parent: '...', base: p };
    }
  };

  const { parent: parentPath, base: baseDir } = formatWorkspacePath(workspaceRoot);
  const showBrain = mcpIdentity !== 'third-party' && mcpIdentity !== 'unknown';
  
  // Calculate dynamic text limits based on sidebar width to prevent overlapping columns
  const valLimit = Math.max(6, width - 14);
  const memLimit = Math.max(8, width - 8);
  const pathLimit = Math.max(4, width - 18);

  // RUNNING FLEET — split into sub-agents / workers / workflows so each kind
  // reads as its own list (rather than one merged "fleet" blob).
  const fleet = groupTasksByKind(bgTasks);
  const PER_GROUP = 3;
  const fmtElapsed = (iso?: string): string => {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h`;
  };
  const renderFleetGroup = (title: string, bg: string, kind: BackgroundTaskKind) => {
    const items = fleet[kind];
    return (
      <Box flexDirection="column" gap={0} marginBottom={1} key={kind}>
        <Text color="black" backgroundColor={bg} bold>{`  ${GLYPH[kind]} ${title} (${items.length})  `}</Text>
        <Box flexDirection="column" marginLeft={1}>
          {items.length === 0 ? (
            <Text color="gray" italic>  · idle</Text>
          ) : (
            items.slice(0, PER_GROUP).map((task, idx) => {
              const isLast = idx === Math.min(items.length, PER_GROUP) - 1;
              const prefix = isLast ? '  └─ ' : '  ├─ ';
              const elapsed = fmtElapsed(task.startedAt);
              // For sub-agents lead with the ROLE (explorer / reviewer / …) +
              // a short id so the user sees *what kind* of agent it is; other
              // kinds keep their rich label (worker already carries its role).
              const shortId = task.id.replace(/^agent-/, '').slice(0, 4);
              const primary = task.role ? `${task.role}·${shortId}` : task.label;
              const wt = task.worktree ? ' ⎇' : ''; // isolated git worktree
              const reserve = (elapsed ? elapsed.length + 1 : 0) + wt.length;
              return (
                <Box key={task.id}>
                  <Text color="gray">{prefix}</Text>
                  <Text color="cyan" wrap="truncate-end">{truncate(primary, Math.max(6, memLimit - reserve))}</Text>
                  {task.worktree ? <Text color="green">{wt}</Text> : null}
                  {elapsed ? <Text color="gray" dimColor>{` ${elapsed}`}</Text> : null}
                </Box>
              );
            })
          )}
          {items.length > PER_GROUP ? (
            <Text color="gray" dimColor>{`     and ${items.length - PER_GROUP} more...`}</Text>
          ) : null}
        </Box>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" gap={0} flexGrow={1} flexShrink={1} overflow="hidden" width="100%">
      {/* 1. ACTIVE CONTEXT */}
      <Box flexDirection="column" gap={0} marginBottom={1}>
        <Text color="black" backgroundColor="cyan" bold>  🧠 ACTIVE CONTEXT  </Text>
        <Box flexDirection="column" marginLeft={1}>
          <Box>
            <Text color="gray">  ├─ Model:   </Text>
            <Text bold color="white">{truncate(model, valLimit)}</Text>
          </Box>
          <Box>
            <Text color="gray">  ├─ Session: </Text>
            <Text bold color="white">{truncate(session, valLimit)}</Text>
          </Box>
          <Box>
            <Text color="gray">  ├─ Effort:  </Text>
            <Text color="magenta">{effort}</Text>
          </Box>
          <Box>
            <Text color="gray">  └─ Mode:    </Text>
            <Text color={getModeColor(accessMode)} bold>{accessMode}</Text>
          </Box>
        </Box>
      </Box>

      {/* 2. WORKSPACE */}
      <Box flexDirection="column" gap={0} marginBottom={1}>
        <Text color="black" backgroundColor="yellow" bold>  📂 ACTIVE PROJECT  </Text>
        <Box flexDirection="column" marginLeft={1}>
          <Box>
            <Text color="gray">  ├─ Branch: </Text>
            <Text color="yellow" bold>{truncate(branch, valLimit)}</Text>
          </Box>
          <Box>
            <Text color="gray">  └─ Path:   </Text>
            <Text color="gray" dimColor>{truncate(parentPath, pathLimit)}/</Text>
            <Text color="white" bold>{truncate(baseDir, valLimit)}</Text>
          </Box>
        </Box>
      </Box>

      {/* 3. CONNECTIONS */}
      <Box flexDirection="column" gap={0} marginBottom={1}>
        <Text color="black" backgroundColor="green" bold>  📡 CONNECTIONS     </Text>
        <Box flexDirection="column" marginLeft={1}>
          {showBrain && (
            <Box>
              <Text color="gray">  ├─ Brain: </Text>
              <Text color={mcpOnline ? 'green' : 'red'} bold>
                {mcpOnline ? '🟢 online' : '🔴 offline'}
              </Text>
            </Box>
          )}
          <Box>
            <Text color="gray">{showBrain ? '  └─ MCP:   ' : '  └─ MCP:   '}</Text>
            <Text color={mcpOnline ? 'green' : 'red'} bold>
              {mcpOnline ? '🟢' : '🔴'}
            </Text>
            <Text color="gray"> ({truncate(mcpProfile, Math.max(4, width - 17))})</Text>
          </Box>
        </Box>
      </Box>

      {/* 4. RECALLED MEMORIES */}
      <Box flexDirection="column" gap={0} marginBottom={1}>
        <Text color="black" backgroundColor="magenta" bold>  💾 MEMORY BRIEFS   </Text>
        <Box flexDirection="column" marginLeft={1}>
          {memories.length === 0 ? (
            <Text color="gray" italic>  · No memories recalled</Text>
          ) : (
            memories.map((m, idx) => {
              const isLast = idx === memories.length - 1;
              const prefix = isLast ? '  └─ ' : '  ├─ ';
              return (
                <Box key={m.id}>
                  <Text color="gray">{prefix}</Text>
                  <Text color="gray" dimColor>{truncate(m.text, memLimit)}</Text>
                </Box>
              );
            })
          )}
        </Box>
      </Box>

      {/* 5. RUNNING FLEET — separated by kind */}
      {renderFleetGroup('SUB-AGENTS', 'blue', 'agent')}
      {renderFleetGroup('WORKERS', 'cyan', 'worker')}
      {renderFleetGroup('WORKFLOWS', 'magenta', 'workflow')}
    </Box>
  );
}
