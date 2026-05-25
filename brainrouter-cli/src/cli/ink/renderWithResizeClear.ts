import type { ReactNode } from 'react';
import { render, type Instance, type RenderOptions } from 'ink';

export interface ResizeClearInkInstance {
  instance: Instance;
  cleanupResizeClear: () => void;
}

/**
 * Ink only force-clears on selected resize paths. BrainRouter's Ink
 * panels redraw full frames, so every terminal resize must clear the
 * previous frame first or old banners/prompts can remain in scrollback.
 */
export function renderWithResizeClear(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): ResizeClearInkInstance {
  const instance = render(node, options);
  const stdout = resolveStdout(options);
  const clearBeforeResize = () => {
    instance.clear();
  };
  stdout.prependListener('resize', clearBeforeResize);
  return {
    instance,
    cleanupResizeClear: () => {
      stdout.off('resize', clearBeforeResize);
    },
  };
}

function resolveStdout(options?: NodeJS.WriteStream | RenderOptions): NodeJS.WriteStream {
  if (!options) return process.stdout;
  if ('write' in options && !('stdout' in options)) return options as NodeJS.WriteStream;
  return ((options as RenderOptions).stdout as NodeJS.WriteStream | undefined) ?? process.stdout;
}
