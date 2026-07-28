/**
 * Lazy, allowlisted syntax-highlighting bundle.
 *
 * Importing the package root registers every grammar and creates a multi-MB
 * chunk. BrainRouter only advertises the languages below, so PrismLight keeps
 * code blocks useful without loading hundreds of unrelated grammars.
 */
import React from 'react';
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

const GRAMMARS = {
  bash, c, cpp, csharp, css, go, java, javascript, json, jsx, markdown, markup,
  python, ruby, rust, sql, toml, tsx, typescript, yaml,
};
for (const [name, grammar] of Object.entries(GRAMMARS)) {
  PrismLight.registerLanguage(name, grammar);
}

export interface PrismCodeBlockProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
}

export default function PrismCodeBlock({ code, language, showLineNumbers }: PrismCodeBlockProps): React.ReactElement {
  const Highlighter = PrismLight as unknown as React.ComponentType<Record<string, unknown>>;
  return (
    <Highlighter
      language={language}
      style={oneDark}
      showLineNumbers={showLineNumbers}
      customStyle={{ background: 'transparent', margin: 0, padding: 0, fontSize: '12px', lineHeight: '1.55' }}
      codeTagProps={{ style: { fontFamily: 'var(--mono)', fontSize: '12px' } }}
      lineNumberStyle={{ minWidth: '38px', paddingRight: '14px', color: 'var(--text-faint)', userSelect: 'none' }}
    >
      {code}
    </Highlighter>
  );
}
