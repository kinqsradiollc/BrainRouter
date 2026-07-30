import { buildTheme } from '../../theme/theme.js';
import { type PromptTextOptions, type PromptTextResult } from './types.js';
import { renderFrame } from './frame-render.js';
import { runFramedInput } from './frame-runtime.js';

// --- promptText --------------------------------------------------------

export async function promptText(opts: PromptTextOptions): Promise<PromptTextResult> {
  return runFramedInput(async (frame) => {
    const theme = opts.theme ?? buildTheme('dark');
    let text = opts.prefilled ?? '';
    let error: string | undefined;

    const computeFrame = (): string => {
      const W = Math.max(60, Math.min((process.stdout.columns ?? 80) - 4, 90));
      const inner = Math.max(20, W - 4);
      const bodyLines: string[] = [];
      const visibleText = text.length === 0
        ? theme.dim(opts.placeholder ?? '(type here)')
        : opts.mask ? maskInput(text) : text;
      bodyLines.push('   ' + theme.info('›') + ' ' + visibleText + theme.muted('_'));
      if (error) {
        bodyLines.push('');
        bodyLines.push('   ' + theme.danger('✗ ' + error));
      }
      return renderFrame({
        theme,
        title: opts.title,
        subtitle: opts.subtitle,
        badge: opts.badge,
        bodyLines,
        footer: opts.footer ?? '↵ accept  ·  esc cancel  ·  ⌫ erase',
        width: W,
      });
    };

    return new Promise<PromptTextResult>((resolve) => {
      frame.draw(computeFrame());

      frame.onKey((key, str) => {
        if (key.ctrl && (key.name === 'c' || key.sequence === '')) {
          frame.close();
          resolve({ kind: 'cancelled' });
          return;
        }
        if (key.name === 'escape') {
          frame.close();
          resolve({ kind: 'cancelled' });
          return;
        }
        if (key.name === 'return') {
          const validate = opts.validate;
          if (validate) {
            const verdict = validate(text);
            if (verdict !== undefined) {
              error = verdict;
              frame.draw(computeFrame());
              return;
            }
          }
          frame.close();
          resolve({ kind: 'accept', text });
          return;
        }
        if (key.name === 'backspace') {
          if (text.length > 0) {
            text = text.slice(0, -1);
            error = undefined;
            frame.draw(computeFrame());
          }
          return;
        }
        if (typeof str === 'string' && str.length === 1 && !key.ctrl && key.name !== 'tab') {
          text += str;
          error = undefined;
          frame.draw(computeFrame());
          return;
        }
      });
    });
  }, { eraseOnClose: opts.eraseOnClose });
}

function maskInput(s: string): string {
  if (s.length <= 4) return '·'.repeat(s.length);
  return '·'.repeat(Math.max(4, s.length - 4)) + s.slice(-4);
}
