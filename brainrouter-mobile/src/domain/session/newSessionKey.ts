/**
 * Mint a fresh session id for a "New chat" before navigating to the Session
 * screen (which resume-sessions it on the host, creating the conversation). A
 * base36 timestamp plus a monotonic counter so rapid taps within the same
 * millisecond never collide onto the same conversation.
 */
let counter = 0;

export function newSessionKey(): string {
  counter = (counter + 1) % 0x10000;
  return `mobile:${Date.now().toString(36)}-${counter.toString(36)}`;
}
