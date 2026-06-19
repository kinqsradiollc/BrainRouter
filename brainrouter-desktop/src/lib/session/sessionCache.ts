export function sessionRowsCacheKey(workspaceRoot: string | null | undefined, sessionKey: string): string {
  return `${workspaceRoot || 'unknown'}::${sessionKey}`;
}
