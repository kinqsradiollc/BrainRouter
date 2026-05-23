"use client";

// Shared markdown renderer for all dashboard surfaces that display
// LLM-authored prose (Memory-Augmented Chat, Core Identity, Scene
// summaries). Centralizes plugin choice so adding GFM, footnotes, or
// custom renderers later happens in one place instead of three.
//
// Math support is on by default: `remark-math` parses `$inline$` and
// `$$display$$` LaTeX, `rehype-katex` renders it via KaTeX. The CSS is
// imported once in app/layout.tsx so every page that uses this component
// gets the styling without per-page imports.
//
// This wrapper deliberately does NOT add its own div — call sites apply
// the `.markdown-content` class (and any modifier like `--chat`) on
// their own outer element. That keeps the bubble-pending / empty-state
// branching in the call site rather than baking it in here.

import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/**
 * Normalize LaTeX delimiters that remark-math doesn't recognize natively
 * into the `$...$` / `$$...$$` forms it does. Three transforms:
 *
 *   \[ ... \]                              →  $$ ... $$   (display math)
 *   \( ... \)                              →  $ ... $     (inline math)
 *   \begin{equation|align|gather|…}…\end…  →  $$ wrapped  (named environments)
 *
 * Fenced code blocks (```...```) and inline code (`...`) are skipped so a
 * LaTeX source example embedded in a code fence stays a code example
 * instead of getting silently rendered as math.
 */
function normalizeLatexDelimiters(md: string): string {
  // Math environments KaTeX renders when inside `$$...$$`. Listed here so
  // standalone `\begin{align}...\end{align}` blocks get auto-wrapped.
  const mathEnvs = "equation|align|gather|multline|eqnarray|alignat|flalign";
  const envRegex = new RegExp(
    `\\\\begin\\{(${mathEnvs})\\*?\\}[\\s\\S]+?\\\\end\\{\\1\\*?\\}`,
    "g",
  );

  // Split on code regions, keeping the delimiters. Even indices are prose
  // (we transform); odd indices are code (we leave alone).
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(envRegex, (match) => `$$\n${match}\n$$`)
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `$$\n${body}\n$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body}$`);
    })
    .join("");
}

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeKatex]}
    >
      {normalizeLatexDelimiters(children)}
    </ReactMarkdown>
  );
}
