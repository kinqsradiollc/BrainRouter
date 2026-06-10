import React from 'react';
import { Box, Text } from 'ink';

interface WelcomeViewProps {
  workspaceRoot: string;
  accentColor: string;
}

export function WelcomeView({ workspaceRoot, accentColor }: WelcomeViewProps) {
  return (
    <Box flexDirection="column" padding={1}>
      {/* Welcome Banner */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={accentColor} bold>
          {'██████╗ ██████╗  █████╗ ██╗███╗   ██╗██████╗  ██████╗ ██╗   ██╗████████╗███████╗██████╗'}
        </Text>
        <Text color={accentColor} bold>
          {'██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝██╔════╝██╔══██╗'}
        </Text>
        <Text color={accentColor} bold>
          {'██████╔╝██████╔╝███████║██║██╔██╗ ██║██████╔╝██║   ██║██║   ██║   ██║   █████╗  ██████╔╝'}
        </Text>
        <Text color={accentColor} bold>
          {'██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║██╔══██╗██║   ██║██║   ██║   ██║   ██╔══╝  ██╔══██╗'}
        </Text>
        <Text color={accentColor} bold>
          {'██████╔╝██║  ██║██║  ██║██║██║ ╚████║██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████╗██║  ██║'}
        </Text>
        <Text color={accentColor} bold>
          {'╚══════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝'}
        </Text>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            The Memory-Native Cognitive Router and Multi-Agent Orchestrator
          </Text>
        </Box>
      </Box>

      {/* active workspace */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>WORKSPACE INFO</Text>
        <Text color="gray">  Root: <Text color="white">{workspaceRoot}</Text></Text>
      </Box>

      {/* Navigation shortcuts */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>TUI NAVIGATION SHORTCUTS</Text>

        <Box flexDirection="column" marginLeft={2} marginTop={1} gap={0}>
          <Box>
            <Text color={accentColor} bold>Ctrl + Tab  </Text>
            <Text color="gray">─  Cycle workspace view (Home, Session, Workflows, MCP)</Text>
          </Box>
          <Box>
            <Text color={accentColor} bold>Ctrl + P    </Text>
            <Text color="gray">─  Toggle Search / Command Palette overlay</Text>
          </Box>
          <Box>
            <Text color={accentColor} bold>Shift + Tab </Text>
            <Text color="gray">─  Cycle access permissions (read → write → shell)</Text>
          </Box>
          <Box>
            <Text color={accentColor} bold>Ctrl + L    </Text>
            <Text color="gray">─  Clear current session chat scrollback view</Text>
          </Box>
          <Box>
            <Text color={accentColor} bold>Ctrl + C    </Text>
            <Text color="gray">─  Exit BrainRouter CLI and disconnect MCP links</Text>
          </Box>
        </Box>
      </Box>

      {/* Next steps hint */}
      <Box marginTop={1}>
        <Text color="gray" italic>
          To get started, switch to the Chat Session (Ctrl+Tab) and type your first instruction.
        </Text>
      </Box>
    </Box>
  );
}
