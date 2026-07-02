/**
 * useMarkdownMode — the folded-in Docs experience for .md/.markdown/.mdx files:
 * the edit/split/preview toggle, HTML/Word export + rich-text copy, and the
 * Selection-AI inline rewrite → review-overlay flow. Lifted verbatim out of
 * EditorPanel so the panel component composes it instead of inlining ~90 lines
 * of markdown handlers. All bodies are byte-identical to the originals.
 */
import { useCallback, useEffect, useState } from 'react';
import { type OnMount } from '@monaco-editor/react';
import { hostQuery } from '../../lib/hostQuery.js';
import { renderBody, htmlDoc } from '../../lib/docs/markdownExport.js';
import { computeReviewChunks, applyReview, type ReviewDecision } from '@kinqs/brainrouter-core/dist/write/writeDiff.js';
import { ACTION_LABEL, type InlineAction, type MonacoRange, type ReviewSession } from '../editor/markdownMode.js';
import { type EditorTab } from '../../lib/editor/editorModel.js';

export interface MarkdownMode {
  mdView: 'edit' | 'split' | 'preview';
  setMdView: React.Dispatch<React.SetStateAction<'edit' | 'split' | 'preview'>>;
  review: ReviewSession | null;
  setReview: React.Dispatch<React.SetStateAction<ReviewSession | null>>;
  mdStatus: string;
  setMdStatus: React.Dispatch<React.SetStateAction<string>>;
  aiBusy: boolean;
  exportAs: (kind: 'html' | 'doc') => Promise<void>;
  copyRich: () => Promise<void>;
  runInline: (action: InlineAction) => Promise<void>;
  setDecision: (id: number, decision: ReviewDecision) => void;
  setAllDecisions: (decision: ReviewDecision) => void;
  applyReviewToDoc: () => void;
}

export function useMarkdownMode(
  mdTab: EditorTab | null,
  mdEditor: () => Parameters<OnMount>[0] | null,
): MarkdownMode {
  const [mdView, setMdView] = useState<'edit' | 'split' | 'preview'>(() => (localStorage.getItem('br-editor-mdview') as 'edit' | 'split' | 'preview') || 'split');
  const [review, setReview] = useState<ReviewSession | null>(null);
  const [mdStatus, setMdStatus] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => { localStorage.setItem('br-editor-mdview', mdView); }, [mdView]);

  const exportAs = useCallback(async (kind: 'html' | 'doc') => {
    if (!mdTab) return;
    setMdStatus('Exporting…');
    const title = mdTab.path.split('/').pop() ?? 'document';
    const doc = htmlDoc(title, renderBody(mdTab.content), { word: kind === 'doc' });
    const outPath = `${mdTab.path.replace(/\.[^/.]+$/, '')}.${kind}`;
    const res = await hostQuery<{ ok?: boolean; error?: string }>('write-save', { path: outPath, content: doc });
    setMdStatus(res?.ok ? `Exported to ${outPath}` : `Export failed${res?.error ? `: ${res.error}` : ''}.`);
  }, [mdTab]);

  const copyRich = useCallback(async () => {
    if (!mdTab) return;
    const html = htmlDoc(mdTab.path.split('/').pop() ?? 'document', renderBody(mdTab.content));
    try {
      const clip = navigator.clipboard as Clipboard & { write?: (items: ClipboardItem[]) => Promise<void> };
      if (typeof ClipboardItem !== 'undefined' && clip.write) {
        await clip.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([mdTab.content], { type: 'text/plain' }) })]);
        setMdStatus('Copied as rich text.'); return;
      }
      await navigator.clipboard.writeText(mdTab.content);
      setMdStatus('Copied as plain text (rich text unavailable here).');
    } catch { setMdStatus('Copy failed — the clipboard is unavailable.'); }
  }, [mdTab]);

  const runInline = useCallback(async (action: InlineAction) => {
    const ed = mdEditor();
    const sel = ed?.getSelection();
    const model = ed?.getModel();
    if (!ed || !sel || sel.isEmpty() || !model || !mdTab) { setMdStatus('Select some text first.'); return; }
    const text = model.getValueInRange(sel);
    if (!text.trim()) { setMdStatus('Select some text first.'); return; }
    const range: MonacoRange = { startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.endLineNumber, endColumn: sel.endColumn };
    setAiBusy(true); setMdStatus(`${ACTION_LABEL[action]}…`);
    const res = await hostQuery<{ text?: string; error?: string }>('write-inline-ai', { action, text, doc: mdTab.content });
    setAiBusy(false);
    if (!res || res.error || typeof res.text !== 'string') { setMdStatus(res?.error ? `Inline AI: ${res.error}` : 'Inline AI is unavailable (is a model configured?).'); return; }
    if (res.text === text) { setMdStatus('No change suggested.'); return; }
    setReview({ chunks: computeReviewChunks(text, res.text), decisions: {}, range, action });
    setMdStatus('');
  }, [mdTab]);

  const setDecision = useCallback((id: number, decision: ReviewDecision) => setReview((r) => (r ? { ...r, decisions: { ...r.decisions, [id]: decision } } : r)), []);
  const setAllDecisions = useCallback((decision: ReviewDecision) => setReview((r) => {
    if (!r) return r;
    const d: Record<number, ReviewDecision> = {};
    for (const c of r.chunks) if (c.op !== 'equal') d[c.id] = decision;
    return { ...r, decisions: d };
  }), []);
  const applyReviewToDoc = useCallback(() => setReview((r) => {
    if (!r) return null;
    const result = applyReview(r.chunks, r.decisions, 'accept');
    const ed = mdEditor();
    if (ed) { ed.executeEdits('inline-ai', [{ range: r.range, text: result, forceMoveMarkers: true }]); ed.focus(); }
    setMdStatus(`Applied — ${ACTION_LABEL[r.action]}.`);
    return null;
  }), []);

  return { mdView, setMdView, review, setReview, mdStatus, setMdStatus, aiBusy, exportAs, copyRich, runInline, setDecision, setAllDecisions, applyReviewToDoc };
}
