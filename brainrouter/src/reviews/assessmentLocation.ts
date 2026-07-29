import { redactSecrets } from "@kinqs/brainrouter-core/git";

function safeRepositoryRelativePath(value: string): boolean {
  if (
    !value
    || value.startsWith("/")
    || value.includes("\\")
    || /[\0\r\n?#@:]/.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Keep only credential-free HTTP(S) locations or repository-relative paths.
 * Opaque schemes and malformed URL-like values are discarded rather than
 * persisted as evidence or long-lived memory metadata.
 */
export function safeAssessmentLocation(
  value: unknown,
  maxLength = 2_000,
): string | undefined {
  const location = redactSecrets(String(value ?? "").trim()).slice(0, maxLength);
  if (!location) return undefined;
  try {
    const parsed = new URL(location);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return safeRepositoryRelativePath(location) ? location : undefined;
  }
}
