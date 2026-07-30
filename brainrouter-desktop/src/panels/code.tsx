/**
 * Shared syntax-highlight primitive used by the file viewer and the chat
 * markdown renderer. Theme-matched: transparent bg, our mono var, dim gutter.
 *
 * PERF: Prism (react-syntax-highlighter + the prism theme) is ~500KB and was
 * imported at module top, so it landed in the INITIAL bundle via the chat
 * markdown renderer (loaded for every assistant message) even when no code
 * block was on screen. It's now lazy-loaded — a fenced block renders as plain
 * <pre> instantly and upgrades to highlighted once the highlighter chunk
 * arrives. A chat with no code never pays for Prism.
 */
import React from 'react';

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

interface CodeBlockProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
}

// Lazy chunk: pull Prism + the prism theme only when a code block first renders.
const LazyHighlighter = React.lazy(() => import('./PrismCodeBlock.js'));

/** Theme-matched code block: transparent bg, our mono var, dim gutter. */
export function CodeBlock({ code, language, showLineNumbers }: CodeBlockProps): React.ReactElement {
  // Plain-text fallback shown instantly (and while the highlighter chunk loads).
  const fallback = (
    <pre style={{ background: 'transparent', margin: 0, padding: 0, overflowX: 'auto' }}>
      <code style={{ fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.55' }}>{code}</code>
    </pre>
  );
  return (
    <React.Suspense fallback={fallback}>
      <LazyHighlighter code={code} language={language} showLineNumbers={showLineNumbers} />
    </React.Suspense>
  );
}
