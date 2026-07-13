import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../../theme/theme.js';
import { VERSION } from '@kinqs/brainrouter-core/version';

interface TuiHeaderProps {
  cols: number;
  theme: Theme;
  accentColor?: string;
  mcpProfile?: string;
  mcpTransport?: string;
  mcpOnline?: boolean;
  mcpIdentity?: 'brainrouter' | 'third-party' | 'unknown';
}

export function TuiHeader({
  cols,
  theme,
  accentColor,
  mcpProfile = 'local-http',
  mcpTransport = 'http',
  mcpOnline = false,
  mcpIdentity = 'unknown',
}: TuiHeaderProps) {
  const accent = accentColor ?? theme.colors.primary;
  const title = cols >= 30 ? `brainrouter cli · ${VERSION}` : 'brainrouter';

  // Determine statuses on the right
  let rightText = '';
  if (cols >= 80) {
    const brainStatusText = mcpIdentity !== 'third-party' && mcpIdentity !== 'unknown'
      ? (mcpOnline ? 'brain online' : 'brain offline')
      : '';
    const mcpStatusText = mcpOnline
      ? `mcp ${mcpProfile} · ${mcpTransport}`
      : `mcp offline · ${mcpProfile}`;
    rightText = [brainStatusText, mcpStatusText].filter(Boolean).join('  ·  ');
  } else if (cols >= 50) {
    const brainStatusText = mcpIdentity !== 'third-party' && mcpIdentity !== 'unknown'
      ? (mcpOnline ? 'brain ●' : 'brain ○')
      : '';
    const mcpStatusText = mcpOnline ? 'mcp ●' : 'mcp ○';
    rightText = [brainStatusText, mcpStatusText].filter(Boolean).join('  ·  ');
  }

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box flexDirection="row" justifyContent="space-between" paddingX={1} width="100%">
        <Text bold color={accent}>
          {title}
        </Text>
        {rightText ? <Text color={mcpOnline ? theme.colors.success : theme.colors.danger} dimColor>{rightText}</Text> : null}
      </Box>
      <Text color="gray" dimColor>
        {'─'.repeat(Math.max(10, cols - 2))}
      </Text>
    </Box>
  );
}
