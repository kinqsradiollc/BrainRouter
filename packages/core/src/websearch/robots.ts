interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

interface RobotsCacheEntry {
  expiresAt: number;
  groups: RobotsGroup[];
}

const ROBOTS_TTL_MS = 5 * 60_000;
const robotsCache = new Map<string, RobotsCacheEntry>();

export function clearRobotsCacheForTests(): void {
  robotsCache.clear();
}

export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let hasRules = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || hasRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        hasRules = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ type: field, path: value });
      hasRules = true;
    }
  }

  return groups;
}

function agentMatches(groupAgent: string, userAgent: string): boolean {
  if (groupAgent === '*') return true;
  const token = userAgent.toLowerCase().split('/')[0];
  return !!token && (groupAgent.includes(token) || token.includes(groupAgent));
}

export function isPathAllowedByRules(pathname: string, groups: RobotsGroup[], userAgent: string): boolean {
  const matchingRules = groups
    .filter((group) => group.agents.some((agent) => agentMatches(agent, userAgent)))
    .flatMap((group) => group.rules)
    .filter((rule) => rule.path !== '' && pathname.startsWith(rule.path));
  if (matchingRules.length === 0) return true;
  matchingRules.sort((a, b) => b.path.length - a.path.length || (a.type === 'allow' ? -1 : 1));
  return matchingRules[0].type === 'allow';
}

export async function isAllowedByRobots(
  targetUrl: string,
  opts: { userAgent: string; respectRobots: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<{ allowed: boolean; reason?: string }> {
  if (!opts.respectRobots) return { allowed: true };
  const parsed = new URL(targetUrl);
  const origin = parsed.origin;
  const now = Date.now();
  let entry = robotsCache.get(origin);
  if (!entry || entry.expiresAt <= now) {
    try {
      const fetcher = opts.fetchImpl ?? fetch;
      const robotsUrl = new URL('/robots.txt', origin);
      const res = await fetcher(robotsUrl, {
        headers: { 'User-Agent': opts.userAgent },
        signal: opts.signal,
      });
      const text = res.ok ? await res.text() : '';
      entry = { expiresAt: now + ROBOTS_TTL_MS, groups: parseRobotsTxt(text) };
    } catch {
      entry = { expiresAt: now + ROBOTS_TTL_MS, groups: [] };
    }
    robotsCache.set(origin, entry);
  }
  const allowed = isPathAllowedByRules(parsed.pathname || '/', entry.groups, opts.userAgent);
  return allowed ? { allowed } : { allowed: false, reason: `robots.txt disallows ${parsed.pathname || '/'}` };
}
