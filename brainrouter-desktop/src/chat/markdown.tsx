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
