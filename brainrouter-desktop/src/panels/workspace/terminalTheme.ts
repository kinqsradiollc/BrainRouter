import type { ITheme } from '@xterm/xterm';

interface CssValues {
  getPropertyValue: (name: string) => string;
}

function value(styles: CssValues, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

export function terminalTheme(styles: CssValues): ITheme {
  return {
    background: value(styles, '--term-bg', '#121212'),
    foreground: value(styles, '--text', '#ececec'),
    cursor: value(styles, '--text', '#ececec'),
    cursorAccent: value(styles, '--term-bg', '#121212'),
    selectionBackground: value(styles, '--terminal-selection', '#ffffff2e'),
    black: value(styles, '--terminal-ansi-black', '#1d1f21'),
    red: value(styles, '--terminal-ansi-red', '#cc6666'),
    green: value(styles, '--terminal-ansi-green', '#b5bd68'),
    yellow: value(styles, '--terminal-ansi-yellow', '#f0c674'),
    blue: value(styles, '--terminal-ansi-blue', '#81a2be'),
    magenta: value(styles, '--terminal-ansi-magenta', '#b294bb'),
    cyan: value(styles, '--terminal-ansi-cyan', '#8abeb7'),
    white: value(styles, '--terminal-ansi-white', '#c5c8c6'),
    brightBlack: value(styles, '--terminal-ansi-bright-black', '#666666'),
    brightRed: value(styles, '--terminal-ansi-bright-red', '#d54e53'),
    brightGreen: value(styles, '--terminal-ansi-bright-green', '#b9ca4a'),
    brightYellow: value(styles, '--terminal-ansi-bright-yellow', '#e7c547'),
    brightBlue: value(styles, '--terminal-ansi-bright-blue', '#7aa6da'),
    brightMagenta: value(styles, '--terminal-ansi-bright-magenta', '#c397d8'),
    brightCyan: value(styles, '--terminal-ansi-bright-cyan', '#70c0b1'),
    brightWhite: value(styles, '--terminal-ansi-bright-white', '#eaeaea'),
  };
}
