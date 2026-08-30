/**
 * The chat markdown renderer: react-markdown + remark-gfm, with fenced code
 * blocks routed through the same highlighter as the File view.
 */
import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Icon } from '../icons.js';
import { CodeBlock } from '../panels/index.js';

// react-markdown's return type clashes with the workspace-hoisted @types/react;
// the runtime component is a plain function component.
export const Markdown = ReactMarkdown as unknown as React.ComponentType<{ remarkPlugins?: unknown[]; components?: Record<string, unknown>; children: string }>;

/** Fenced code blocks render through the same highlighter as the File view. */
export const MD_COMPONENTS: Record<string, unknown> = {
  // A GFM table renders full-width so a narrow table (few columns) fills the
  // message column instead of leaving dead space to its right; the wrapper is the
  // horizontal-scroll container so a WIDE table still scrolls rather than
  // overflowing. (The border/radius live on the wrapper — see `.md-table-wrap`.)
  table(props: { children?: React.ReactNode }) {
    return <div className="md-table-wrap"><table>{props.children}</table></div>;
  },
  // HOTFIX — links were dead: react-markdown emitted a plain <a href>, but the
  // renderer can't navigate away (will-navigate denies it) and target=_blank is
  // blocked, so clicking a PR/CI link did nothing. Route the URL to the host to
  // open in the system browser; right-click copies it (no menu otherwise).
  a(props: { href?: string; children?: React.ReactNode }) {
    const href = props.href ?? '';
    if (!/^https?:\/\//i.test(href)) return <a href={href}>{props.children}</a>;
    return (
      <a href={href} title={`${href} — right-click to copy`}
        onClick={(e) => {
          e.preventDefault();
          try { window.brainrouter?.send?.({ kind: 'query', id: 'q-open-link', name: 'action:open-external', args: { url: href } }); } catch { /* no bridge (dev) */ }
        }}
        onContextMenu={(e) => { e.preventDefault(); void navigator.clipboard.writeText(href); }}>
        {props.children}
      </a>
    );
  },
  code(props: { inline?: boolean; className?: string; children?: React.ReactNode }) {
    const match = /language-([\w-]+)/.exec(props.className ?? '');
    const text = String(props.children ?? '').replace(/\n$/, '');
    if (props.inline || (!match && !text.includes('\n'))) {
      return <code className={props.className}>{props.children}</code>;
    }
    return (
      <div className="md-code">
        <div className="md-code-bar">
          <span>{match?.[1] ?? 'text'}</span>
          <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(text)}><Icon name="copy" size={12} /></button>
        </div>
        <CodeBlock code={text} language={match?.[1] ?? 'text'} />
      </div>
    );
  },
};
