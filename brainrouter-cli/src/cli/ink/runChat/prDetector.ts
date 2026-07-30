import { execSync } from 'node:child_process';

/**
 * gh-PR detector with a 30s TTL cache — same behaviour as the readline REPL
 * so the statusline doesn't pay 300ms per prompt redraw. Each `runChat`
 * mount gets its own detector instance (closure-private cache).
 */
export function createGitHubPRDetector(): (cwd: string) => string | null {
  // gh-PR detector cache — same 30s TTL as the readline REPL so the
  // statusline doesn't pay 300ms per prompt redraw.
  let prCache: { value: string | null; cachedAt: number } | null = null;
  const PR_CACHE_TTL_MS = 30_000;
  return function detectGitHubPR(cwd: string): string | null {
    const now = Date.now();
    if (prCache && now - prCache.cachedAt < PR_CACHE_TTL_MS) return prCache.value;
    let value: string | null = null;
    try {
      const out = execSync('gh pr view --json number,title 2>/dev/null', {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
      }).toString().trim();
      if (out) {
        const parsed = JSON.parse(out) as { number?: number };
        if (typeof parsed.number === 'number') value = `#${parsed.number}`;
      }
    } catch { /* gh missing or no PR */ }
    prCache = { value, cachedAt: now };
    return value;
  };
}
