/**
 * Edge trimming without backtracking.
 *
 * CodeQL flags `/\/+$/` and friends as `js/polynomial-redos`, and it is right:
 * an anchored `+` makes the engine retry from every position, so a string of
 * many repeated characters costs O(n²). It is polynomial rather than
 * exponential, which is why it never showed up as a hang — just as a machine
 * getting slower under input nobody thought about.
 *
 * These do the same job in one pass. Not a wrapper around a safer regex — no
 * regex at all, so there is nothing left to backtrack.
 */

/** Strip every trailing occurrence of `char`. */
export function trimTrailing(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** Strip every leading occurrence of `char`. */
export function trimLeading(value: string, char: string): string {
  let start = 0;
  while (start < value.length && value[start] === char) start += 1;
  return start === 0 ? value : value.slice(start);
}

/** Strip trailing characters that appear in `chars`. */
export function trimTrailingAny(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1]!)) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** The common case: a URL or path with any number of trailing slashes. */
export function stripTrailingSlashes(value: string): string {
  return trimTrailing(value, '/');
}

/** The common case: a path with any number of leading slashes. */
export function stripLeadingSlashes(value: string): string {
  return trimLeading(value, '/');
}
