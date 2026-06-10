import React from 'react';
import { Box } from 'ink';

interface GridWorkspaceProps {
  children: React.ReactNode;
  sidebar: React.ReactNode;
  cols: number;
  mainWidth: number;
  sidebarWidth: number;
  flexGrow?: number;
  height?: number | string;
}

export function GridWorkspace({
  children,
  sidebar,
  cols,
  mainWidth,
  sidebarWidth,
  flexGrow,
  height,
}: GridWorkspaceProps) {
  // Collapse sidebar if the screen width is too narrow
  const showSidebar = cols >= 100;

  if (!showSidebar) {
    return (
      <Box
        flexDirection="column"
        width="100%"
        flexGrow={flexGrow}
        height={height}
        overflow="hidden"
      >
        {children}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="row"
      width="100%"
      flexGrow={flexGrow}
      height={height}
      overflow="hidden"
    >
      {/* Main workspace view (70% width) with height constraints */}
      <Box
        flexDirection="column"
        width={mainWidth}
        marginRight={2}
        alignSelf="stretch"
        overflow="hidden"
      >
        {children}
      </Box>

      {/* Sidebar view (30% width) with left border */}
      <Box
        flexDirection="column"
        width={sidebarWidth}
        paddingLeft={2}
        alignSelf="stretch"
        borderStyle="single"
        borderColor="gray"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
      >
        {sidebar}
      </Box>
    </Box>
  );
}
