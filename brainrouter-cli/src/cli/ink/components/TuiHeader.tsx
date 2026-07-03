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
  accentColor = '#CC9166',
  mcpProfile = 'local-http',
  mcpOnline = false,
  mcpIdentity = 'unknown',
}: TuiHeaderProps) {
  // Determine title text based on width
  const title = cols >= 45 ? `🧠 BRAINROUTER CLI v${VERSION}` : `🧠 BRAINROUTER`;

  // Determine statuses on the right
  let rightText = '';
  if (cols >= 80) {
    const brainStatusText = mcpIdentity !== 'third-party' && mcpIdentity !== 'unknown'
      ? (mcpOnline ? '🟢 brain: online' : '🔴 brain: offline')
      : '';
    const mcpStatusText = mcpOnline
      ? `🔗 mcp: online (${mcpProfile})`
      : `🔴 mcp: offline (${mcpProfile})`;
    rightText = [brainStatusText, mcpStatusText].filter(Boolean).join('  ·  ');
  } else if (cols >= 50) {
    const brainStatusText = mcpIdentity !== 'third-party' && mcpIdentity !== 'unknown'
      ? (mcpOnline ? '🟢 brain' : '🔴 brain')
      : '';
    const mcpStatusText = mcpOnline ? '🔗 mcp' : '🔴 mcp';
    rightText = [brainStatusText, mcpStatusText].filter(Boolean).join('  ·  ');
  }

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box flexDirection="row" justifyContent="space-between" paddingX={1} width="100%">
        <Text bold color={accentColor}>
          {title}
        </Text>
        {rightText ? <Text color="gray" dimColor>{rightText}</Text> : null}
      </Box>
      <Text color="gray" dimColor>
        {'─'.repeat(Math.max(10, cols))}
      </Text>
    </Box>
  );
}
