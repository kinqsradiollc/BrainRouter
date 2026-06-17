/**
 * Shared syntax-highlight primitive used by the file viewer and the chat
 * markdown renderer. Theme-matched: transparent bg, our mono var, dim gutter.
 */
import React from 'react';
import { Prism } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Same @types/react clash as react-markdown — runtime component is fine.
const Highlighter = Prism as unknown as React.ComponentType<Record<string, unknown>>;

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', html: 'markup', md: 'markdown', py: 'python',
  go: 'go', rs: 'rust', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', sql: 'sql', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby',
};

export function langForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? 'text';
}

/** Theme-matched code block: transparent bg, our mono var, dim gutter. */
export function CodeBlock({ code, language, showLineNumbers }: {
  code: string;
  language: string;
  showLineNumbers?: boolean;
}): React.ReactElement {
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
