const CHALLENGE_TITLE =
  /\b(verify (?:that )?you are human|unusual traffic|security check|before you continue|just a moment)\b/i;

/**
 * Detect only well-known top-level human-verification surfaces. This does not
 * inspect or solve a challenge; it tells the host to hand the visible tab back
 * to the user until ordinary navigation resumes.
 */
export function humanChallengeReason(url: string, title: string): string | null {
  try {
    const parsed = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname) && parsed.pathname.startsWith('/sorry/')) {
      return 'Google requested human verification.';
    }
  } catch {
    // An invalid/incomplete navigation cannot be classified as a challenge.
  }
  return CHALLENGE_TITLE.test(title) ? 'This site requested human verification.' : null;
}
