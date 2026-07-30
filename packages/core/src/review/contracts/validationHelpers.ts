/**
 * Shared runtime-validation primitives for repository-assurance contracts.
 *
 * These helpers carry no domain policy; run, finding, and impact validators
 * retain their own authority and cross-field rules in focused modules.
 */

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

export function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

export function checkString(
  target: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): void {
  if (!nonEmpty(target[key])) issues.push(`${path}.${key} must be a non-empty string`);
}

const FORBIDDEN_SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'password',
  'secret',
  'credential',
  'authorization',
]);

export function checkForbiddenSecretKeys(
  value: unknown,
  issues: string[],
  path = 'run',
  seen = new WeakSet<object>(),
  depth = 0,
): void {
  if (depth > 20 || value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      checkForbiddenSecretKeys(item, issues, `${path}[${index}]`, seen, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
      issues.push(`${path}.${key} is forbidden in a secret-free assurance record`);
      continue;
    }
    checkForbiddenSecretKeys(child, issues, `${path}.${key}`, seen, depth + 1);
  }
}
