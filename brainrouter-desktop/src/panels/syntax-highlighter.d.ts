declare module 'react-syntax-highlighter/dist/esm/prism-light' {
  import type { ComponentType } from 'react';

  const PrismLight: ComponentType<Record<string, unknown>> & {
    registerLanguage(name: string, grammar: unknown): void;
  };
  export default PrismLight;
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/one-dark' {
  const style: Record<string, Record<string, string | number>>;
  export default style;
}

declare module 'react-syntax-highlighter/dist/esm/languages/prism/*' {
  const grammar: unknown;
  export default grammar;
}
