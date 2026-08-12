/**
 * ADR-034 — browser-safe presentation policy for untrusted peer text.
 *
 * Transport, mailbox, transcript, and model content remain untouched; only
 * human-facing copies pass through this pure helper so terminal controls cannot
 * execute and browser hosts do not need a Node-only Core subsystem barrel.
 */

/** Remove terminal control sequences while preserving ordinary text and lines. */
export function sanitizePeerTextForTerminal(value: string): string {
  let output = '';
  let state: 'text' | 'escape' | 'csi' | 'control-string' = 'text';
  let pendingCr = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = character.charCodeAt(0);

    if (state === 'control-string') {
      if (code === 0x07 || code === 0x9c) state = 'text';
      else if (code === 0x1b && value[index + 1] === '\\') {
        state = 'text';
        index += 1;
      }
      continue;
    }

    if (state === 'csi') {
      if (code >= 0x40 && code <= 0x7e) state = 'text';
      continue;
    }

    if (state === 'escape') {
      if (character === '[') state = 'csi';
      else if (character === ']' || character === 'P' || character === 'X' ||
          character === '^' || character === '_') state = 'control-string';
      else if (code < 0x20 || code > 0x2f) state = 'text';
      continue;
    }

    if (pendingCr && character !== '\n') output += '\n';
    pendingCr = false;
    if (code === 0x1b) {
      state = 'escape';
      continue;
    }
    if (code === 0x9b) {
      state = 'csi';
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      state = 'control-string';
      continue;
    }
    if (character === '\r') {
      pendingCr = true;
      continue;
    }
    if (character === '\n') {
      output += '\n';
      continue;
    }
    if (character === '\t') {
      output += '  ';
      continue;
    }
    if (code < 0x20 || code === 0x7f || code >= 0x80 && code <= 0x9f) continue;
    output += character;
  }
  if (pendingCr) output += '\n';
  return output;
}
