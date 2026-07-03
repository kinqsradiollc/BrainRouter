import React from 'react';
import { Box, Text } from 'ink';

/**
 * Bordered panel chrome shared by every Ink picker / prompt in the
 * 0.3.7 redesign.
 *
 * Why a Frame component? Ink owns the render loop and diffs the cell
 * grid between frames — so we don't have to track cursor positions or
 * worry about lines stacking. Every picker / wizard step / config
 * panel is a `<Frame>` with a title, optional badge, and a body. Ink
 * handles all the redraw mechanics that the previous raw-stdout
 * approach got wrong.
 *
 * Visual reference: matches the previous renderFrame() chrome —
 * theme-colored border, bold title left, muted badge right, muted
 * footer hint at the bottom.
 */

export interface FrameProps {
  title: string;
  badge?: string;
  subtitle?: string;
  footer?: string;
  /** Border color — defaults to brand orange. */
  accentColor?: string;
  children?: React.ReactNode;
}

export function Frame({ title, badge, subtitle, footer, accentColor = '#CC9166', children }: FrameProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor} paddingX={1} marginY={0}>
      <Box justifyContent="space-between" marginBottom={subtitle ? 0 : 0}>
        <Text bold color={accentColor}>{title}</Text>
        {badge ? <Text color="gray">{badge}</Text> : null}
      </Box>
      {subtitle ? (
        <Box marginBottom={1}>
          <Text color="gray">{subtitle}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column">
        {children}
      </Box>
      {footer ? (
        <Box marginTop={1}>
          <Text color="gray" dimColor>{footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
