import path from 'node:path';
import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../../theme/theme.js';

interface WelcomeViewProps {
  workspaceRoot: string;
  accentColor?: string;
  theme?: Theme;
}

/** Compact home surface for orientation; the session remains the primary workspace. */
export function WelcomeView({ workspaceRoot, accentColor, theme }: WelcomeViewProps) {
  const primary = accentColor ?? (theme ? theme.colors.primary : '#8B7CFF');
  const plan = theme ? theme.colors.secondary : '#FF8B73';
  const knowledge = theme ? theme.colors.info : '#4DD8FF';
  const automation = theme ? theme.colors.automation : '#A3E635';
  const project = path.basename(workspaceRoot) || workspaceRoot;

  return (
    <Box flexDirection='column' paddingX={2} paddingY={1}>
      <Box flexDirection='column' marginBottom={1}>
        <Text bold color={primary}>Ready to build</Text>
        <Text color='gray'>Work in <Text bold>{project}</Text>, with project context kept in view.</Text>
        <Text color='gray' dimColor wrap='truncate'>{workspaceRoot}</Text>
      </Box>

      <Box flexDirection='column' marginBottom={1}>
        <Text bold>Choose a workspace</Text>
        <Box marginTop={1}>
          <Text color={primary}>●  Session      </Text>
          <Text color='gray'>Ask, edit, run, and review in one thread</Text>
        </Box>
        <Box>
          <Text color={plan}>●  Plan & track  </Text>
          <Text color='gray'>Inspect requirements and active work</Text>
        </Box>
        <Box>
          <Text color={automation}>●  Workflows     </Text>
          <Text color='gray'>Watch automations, workers, and agents</Text>
        </Box>
        <Box>
          <Text color={knowledge}>●  Connections   </Text>
          <Text color='gray'>Check MCP and knowledge availability</Text>
        </Box>
      </Box>

      <Box flexDirection='column'>
        <Text bold>Keyboard</Text>
        <Text color='gray'><Text color={primary}>Ctrl+Tab</Text> view  ·  <Text color={primary}>Ctrl+P</Text> commands  ·  <Text color={primary}>Shift+Tab</Text> access</Text>
        <Text color='gray' dimColor>Start typing in Session. Use / for actions and ? for shortcuts.</Text>
      </Box>
    </Box>
  );
}
