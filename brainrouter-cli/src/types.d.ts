declare module 'marked-terminal' {
  export function markedTerminal(options?: any, highlightOptions?: any): any;
  export default class Renderer {
    constructor(options?: any, highlightOptions?: any);
  }
}

declare module 'wrap-ansi' {
  // wrap-ansi@6 ships no bundled types. Minimal signature for the bits we use.
  export default function wrapAnsi(
    input: string,
    columns: number,
    options?: { hard?: boolean; trim?: boolean; wordWrap?: boolean },
  ): string;
}
