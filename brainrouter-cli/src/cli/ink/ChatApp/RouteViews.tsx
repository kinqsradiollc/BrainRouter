// REFAC-CHATAPP-SPLIT (0.4.17) — the `workflow` and `mcp` route bodies,
// extracted verbatim from ChatApp.tsx. Presentational only (props in, JSX out).
import React from 'react';
import { Box, Text } from 'ink';
import type { BackgroundTask } from '@kinqs/brainrouter-core/background';

export function WorkflowView({ bgTasks }: { bgTasks: BackgroundTask[] }) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>WORKFLOWS & DURABLE TASKS</Text>
      <Box flexDirection="column" marginTop={1} gap={1}>
        {bgTasks.length === 0 ? (
          <Text color="gray" italic>No active workflows running in the background.</Text>
        ) : (
          bgTasks.map((task) => (
            <Box key={task.id} flexDirection="column" borderStyle="single" borderColor="cyan" borderDimColor padding={1}>
              <Text bold color="cyan">{`⚡ ${task.kind}: ${task.id.substring(0, 8)}`}</Text>
              <Box marginTop={1}>
                <Text color="white">{task.label}</Text>
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

export function McpView() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>MCP TOOLS & CONSOLE</Text>
      <Box flexDirection="column" marginTop={1} gap={1}>
        <Text color="white">Connected Servers:</Text>
        <Text color="gray">  · filesystem (local)</Text>
        <Text color="gray">  · brainrouter-mcp (memory)</Text>
        <Box marginTop={1}>
          <Text color="gray">Run <Text color="cyan" bold>/tools</Text> or <Text color="cyan" bold>/mcp</Text> to configure servers and view available API actions.</Text>
        </Box>
      </Box>
    </Box>
  );
}
