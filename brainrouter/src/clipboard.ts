import { spawn } from 'node:child_process';

/**
 * Cross-platform clipboard copy. Wraps the OS-native CLI tool so we don't add
 * a dependency.
 *
 *   macOS:    pbcopy
 *   Linux:    wl-copy (Wayland) → xclip (X11) → xsel as a last resort
 *   Windows:  clip
 *
 * Returns a tuple `[ok, error?]`. `ok` is false when no copy tool is available
 * (common on bare Linux containers); the caller should fall back to printing
 * the text so the user can select-copy manually.
 */
export async function copyToClipboard(text: string): Promise<{ ok: boolean; tool?: string; error?: string }> {
  const candidates = (() => {
    if (process.platform === 'darwin') return [['pbcopy', []]] as Array<[string, string[]]>;
    if (process.platform === 'win32') return [['clip', []]] as Array<[string, string[]]>;
    return [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ] as Array<[string, string[]]>;
  })();

  for (const [cmd, args] of candidates) {
    const result = await tryCopy(cmd, args, text);
    if (result.ok) return { ok: true, tool: cmd };
  }
  return { ok: false, error: `no clipboard tool found on ${process.platform}` };
}

function tryCopy(cmd: string, args: string[], text: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve({ ok: false });
      return;
    }
    child.on('error', () => resolve({ ok: false }));
    child.on('close', (code) => resolve({ ok: code === 0 }));
    try {
      child.stdin?.end(text);
    } catch {
      resolve({ ok: false });
    }
  });
}
