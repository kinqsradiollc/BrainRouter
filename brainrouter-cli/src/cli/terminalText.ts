const TERMINAL_TEXT_MAX_CHARS = 4 * 1024;
const TERMINAL_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Bound and remove terminal, line, bidi, and display controls from untrusted text. */
export function sanitizeTerminalText(value: unknown): string {
  return String(value).slice(0, TERMINAL_TEXT_MAX_CHARS).replace(TERMINAL_CONTROL_PATTERN, '');
}
