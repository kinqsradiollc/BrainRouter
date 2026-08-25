/**
 * ADR-049 — the Study mode surface (desktop-only). A thin client: every bit of
 * logic (scheduling, session building, stats, import/export) runs host-side
 * behind `study:*` queries (electron/host/queries.ts); this view fetches, renders,
 * and sends grades. Three panes — deck list, deck editor, and the review session —
 * switched by local state, no router.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  StudyCard, StudyCardProposal, StudyDeck, StudyDeckStats, StudyGrade,
} from '@kinqs/brainrouter-types';
import { bridgeQuery } from '../lib/bridgeQuery.js';

interface SourceHint { kind: string; label: string; hint: string }
interface SourcesResult { profile: string; sources: SourceHint[]; docs: { path: string; title: string }[]; decisions: { path: string; title: string }[] }

interface DeckRow {
  id: string; name: string; description: string; tags: string[];
  updatedAt: string; stats: StudyDeckStats;
}
interface ListResult { decks: DeckRow[]; streak: number; user: string }
interface ReviewItem {
  card: StudyCard;
  isNew: boolean;
  mc: { options: string[]; correctIndex: number };
  previews: Record<StudyGrade, number>;
}
interface SessionResult { items: ReviewItem[]; streak: number }

type Pane =
  | { kind: 'list' }
  | { kind: 'edit'; deckId: string | null }
  | { kind: 'review'; deckId: string; deckName: string };

const GRADES: StudyGrade[] = ['again', 'hard', 'good', 'easy'];
const GRADE_LABEL: Record<StudyGrade, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

function fmtInterval(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1d';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function StudyView(): React.JSX.Element {
  const [pane, setPane] = useState<Pane>({ kind: 'list' });
  return (
    <div className="study-mode">
      {pane.kind === 'list' ? (
        <DeckList
          onNew={() => setPane({ kind: 'edit', deckId: null })}
          onEdit={(id) => setPane({ kind: 'edit', deckId: id })}
          onReview={(id, name) => setPane({ kind: 'review', deckId: id, deckName: name })}
        />
      ) : pane.kind === 'edit' ? (
        <DeckEditor deckId={pane.deckId} onDone={() => setPane({ kind: 'list' })} />
      ) : (
        <ReviewSession
          deckId={pane.deckId}
          deckName={pane.deckName}
          onDone={() => setPane({ kind: 'list' })}
        />
      )}
    </div>
  );
}

// --- deck list -------------------------------------------------------------

function DeckList(props: {
  onNew: () => void;
  onEdit: (id: string) => void;
  onReview: (id: string, name: string) => void;
}): React.JSX.Element {
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    bridgeQuery<ListResult>('study:list', {})
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const onDelete = useCallback((id: string, name: string) => {
    if (!window.confirm(`Delete deck “${name}” and its cards? Your review progress for it stays until you review again.`)) return;
    bridgeQuery('study:delete', { id }).then(load).catch((e) => setError(String(e?.message ?? e)));
  }, [load]);

  const onExport = useCallback(async (id: string, format: 'markdown' | 'csv') => {
    try {
      const r = await bridgeQuery<{ ok: boolean; content?: string; filename?: string }>('study:export', { id, format });
      if (r.ok && r.content) {
        const blob = new Blob([r.content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = r.filename ?? `${id}.txt`; a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) { setError(String((e as Error)?.message ?? e)); }
  }, []);

  if (error) return <div className="study-empty"><p>Couldn’t load decks: {error}</p></div>;
  if (!data) return <div className="study-empty" aria-busy="true" />;

  const totalDue = data.decks.reduce((n, d) => n + d.stats.dueCards + d.stats.newCards, 0);

  return (
    <div className="study-list">
      <header className="study-list__head">
        <div>
          <h1 className="study-list__title">Study</h1>
          <p className="study-list__sub">
            {data.decks.length === 0
              ? 'Decks for this workspace — commit them to share, review to remember.'
              : `${totalDue} card${totalDue === 1 ? '' : 's'} to review${data.streak > 0 ? ` · ${data.streak}-day streak` : ''}`}
          </p>
        </div>
        <button className="study-btn study-btn--primary" onClick={props.onNew}>New deck</button>
      </header>

      {data.decks.length === 0 ? (
        <div className="study-empty">
          <h2>No decks yet</h2>
          <p>Create a deck of flashcards, or import a tab/comma-separated list. Decks live in
            <code> .brainrouter/study/</code> so a <code>git commit</code> shares them with your team.</p>
          <button className="study-btn study-btn--primary" onClick={props.onNew}>Create your first deck</button>
        </div>
      ) : (
        <ul className="study-deckgrid">
          {data.decks.map((d) => (
            <li key={d.id} className="study-deckcard">
              <div className="study-deckcard__main" onClick={() => props.onEdit(d.id)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') props.onEdit(d.id); }}>
                <div className="study-deckcard__name">{d.name}</div>
                {d.description ? <div className="study-deckcard__desc">{d.description}</div> : null}
                <div className="study-deckcard__stats">
                  <span className="study-chip study-chip--total">{d.stats.totalCards} cards</span>
                  {d.stats.newCards > 0 ? <span className="study-chip study-chip--new">{d.stats.newCards} new</span> : null}
                  {d.stats.dueCards > 0 ? <span className="study-chip study-chip--due">{d.stats.dueCards} due</span> : null}
                  {d.stats.totalCards > 0 && d.stats.reviewCards > 0
                    ? <span className="study-chip">{Math.round(d.stats.retention * 100)}% retained</span> : null}
                </div>
              </div>
              <div className="study-deckcard__actions">
                <button className="study-btn study-btn--primary"
                  disabled={d.stats.dueCards + d.stats.newCards === 0}
                  onClick={() => props.onReview(d.id, d.name)}>
                  {d.stats.dueCards + d.stats.newCards === 0 ? 'Reviewed' : 'Review'}
                </button>
                <button className="study-btn" onClick={() => props.onEdit(d.id)}>Edit</button>
                <div className="study-menu">
                  <button className="study-btn study-btn--ghost" title="Export as Markdown" onClick={() => onExport(d.id, 'markdown')}>⬇ md</button>
                  <button className="study-btn study-btn--ghost" title="Export as CSV" onClick={() => onExport(d.id, 'csv')}>csv</button>
                  <button className="study-btn study-btn--ghost study-btn--danger" title="Delete deck" onClick={() => onDelete(d.id, d.name)}>Delete</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- deck editor -----------------------------------------------------------

function DeckEditor(props: { deckId: string | null; onDone: () => void }): React.JSX.Element {
  const [deck, setDeck] = useState<StudyDeck | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.deckId === null) {
      const now = new Date().toISOString();
      setDeck({ schemaVersion: 1, id: newId('deck'), name: 'New deck', description: '', tags: [], cards: [], createdAt: now, updatedAt: now });
      return;
    }
    bridgeQuery<{ deck: StudyDeck | null }>('study:read', { id: props.deckId })
      .then((r) => setDeck(r.deck))
      .catch(() => setDeck(null));
  }, [props.deckId]);

  const save = useCallback(async (next: StudyDeck) => {
    setBusy(true);
    try { await bridgeQuery('study:save', { deck: next }); } finally { setBusy(false); }
  }, []);

  const mutate = useCallback((fn: (d: StudyDeck) => StudyDeck) => {
    setDeck((cur) => (cur ? fn(cur) : cur));
  }, []);

  const addCard = useCallback(() => {
    mutate((d) => ({ ...d, cards: [...d.cards, { id: newId('c'), front: '', back: '', format: 'basic', tags: [], createdAt: new Date().toISOString() }] }));
  }, [mutate]);

  const onImport = useCallback(async (text: string) => {
    const r = await bridgeQuery<{ cards: StudyCard[] }>('study:import', { text });
    mutate((d) => ({ ...d, cards: [...d.cards, ...r.cards] }));
    setImportOpen(false);
  }, [mutate]);

  const onAcceptGenerated = useCallback((accepted: StudyCardProposal[]) => {
    const now = new Date().toISOString();
    const cards: StudyCard[] = accepted.map((p) => ({
      id: newId('c'), front: p.front, back: p.back, format: p.format, tags: p.tags,
      ...(p.provenance ? { provenance: p.provenance } : {}), createdAt: now,
    }));
    mutate((d) => ({ ...d, cards: [...d.cards, ...cards] }));
    setGenerateOpen(false);
  }, [mutate]);

  if (!deck) return <div className="study-empty"><p>Deck not found.</p><button className="study-btn" onClick={props.onDone}>Back</button></div>;

  const commit = async () => { await save(deck); props.onDone(); };

  return (
    <div className="study-editor">
      <header className="study-editor__head">
        <button className="study-btn study-btn--ghost" onClick={props.onDone}>← Decks</button>
        <div className="study-editor__actions">
          <button className="study-btn" onClick={() => setGenerateOpen(true)}>✨ Generate</button>
          <button className="study-btn" onClick={() => setImportOpen(true)}>Import</button>
          <button className="study-btn" onClick={addCard}>Add card</button>
          <button className="study-btn study-btn--primary" onClick={commit} disabled={busy}>Save</button>
        </div>
      </header>

      <div className="study-editor__meta">
        <input className="study-input study-input--title" value={deck.name} placeholder="Deck name"
          onChange={(e) => mutate((d) => ({ ...d, name: e.target.value }))} />
        <input className="study-input" value={deck.description ?? ''} placeholder="Description (optional)"
          onChange={(e) => mutate((d) => ({ ...d, description: e.target.value }))} />
      </div>

      {importOpen ? <ImportDialog onClose={() => setImportOpen(false)} onImport={onImport} /> : null}
      {generateOpen ? <GenerateDialog onClose={() => setGenerateOpen(false)} onAccept={onAcceptGenerated} /> : null}

      {deck.cards.length === 0 ? (
        <div className="study-empty">
          <p>No cards yet. Add one, or import a list (front / back / tags, tab- or comma-separated).</p>
        </div>
      ) : (
        <ol className="study-cardlist">
          {deck.cards.map((card, i) => (
            <li key={card.id} className="study-cardrow">
              <span className="study-cardrow__n">{i + 1}</span>
              <textarea className="study-input study-cardrow__side" rows={2} value={card.front} placeholder="Front / prompt"
                onChange={(e) => mutate((d) => ({ ...d, cards: d.cards.map((c) => c.id === card.id ? { ...c, front: e.target.value } : c) }))} />
              <textarea className="study-input study-cardrow__side" rows={2} value={card.back} placeholder="Back / answer"
                onChange={(e) => mutate((d) => ({ ...d, cards: d.cards.map((c) => c.id === card.id ? { ...c, back: e.target.value } : c) }))} />
              <div className="study-cardrow__aside">
                {card.provenance && card.provenance.kind !== 'manual'
                  ? <span className="study-src" title="Generated — click to trace">{card.provenance.kind}</span> : null}
                <button className="study-btn study-btn--ghost study-btn--danger" title="Remove card"
                  onClick={() => mutate((d) => ({ ...d, cards: d.cards.filter((c) => c.id !== card.id) }))}>✕</button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ImportDialog(props: { onClose: () => void; onImport: (text: string) => void }): React.JSX.Element {
  const [text, setText] = useState('');
  return (
    <div className="study-dialog" role="dialog" aria-label="Import cards">
      <div className="study-dialog__body">
        <h3>Import cards</h3>
        <p>Paste one card per line — <code>front{'\t'}back{'\t'}tags</code> (tab- or comma-separated). Quizlet exports work as-is.</p>
        <textarea className="study-input" rows={8} value={text} placeholder={'What is ownership?\tEach value has one owner\trust'}
          onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="study-dialog__actions">
          <button className="study-btn" onClick={props.onClose}>Cancel</button>
          <button className="study-btn study-btn--primary" disabled={!text.trim()} onClick={() => props.onImport(text)}>Add cards</button>
        </div>
      </div>
    </div>
  );
}

// --- generation with receipts ----------------------------------------------

interface Proposal extends StudyCardProposal { _accepted: boolean }

function GenerateDialog(props: { onClose: () => void; onAccept: (cards: StudyCardProposal[]) => void }): React.JSX.Element {
  const [sources, setSources] = useState<SourcesResult | null>(null);
  const [kind, setKind] = useState<string>('text');
  const [text, setText] = useState('');
  const [pickedPath, setPickedPath] = useState('');
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bridgeQuery<SourcesResult>('study:sources', {}).then((r) => {
      setSources(r);
      if (r.sources[0]) setKind(r.sources[0].kind);
    }).catch(() => setSources({ profile: 'custom', sources: [{ kind: 'text', label: 'Paste text', hint: '' }], docs: [], decisions: [] }));
  }, []);

  const generate = useCallback(async () => {
    setBusy(true); setError(null); setProposals(null);
    try {
      let sourceText = text;
      let ref: string | undefined;
      if (kind === 'atlas' || kind === 'doc' || kind === 'decisions') {
        const r = await bridgeQuery<{ ok: boolean; text?: string; ref?: string; reason?: string }>('study:read-source', { kind, path: pickedPath });
        if (!r.ok || !r.text) { setError(r.reason ?? 'Could not read that source.'); setBusy(false); return; }
        sourceText = r.text; ref = r.ref;
      }
      if (!sourceText.trim()) { setError('Nothing to generate from — add some source text.'); setBusy(false); return; }
      const g = await bridgeQuery<{ ok: boolean; proposals?: StudyCardProposal[]; reason?: string }>('study:generate', { text: sourceText, kind, ref, count: 12 }, 90_000);
      if (!g.ok) { setError(g.reason ?? 'Generation failed.'); setBusy(false); return; }
      const list = (g.proposals ?? []).map((p) => ({ ...p, _accepted: true }));
      setProposals(list);
      if (list.length === 0) setError('The model returned no usable cards. Try a longer or clearer source.');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally { setBusy(false); }
  }, [kind, text, pickedPath]);

  const needsPath = kind === 'doc' || kind === 'decisions';
  const pathOptions = kind === 'decisions' ? sources?.decisions ?? [] : sources?.docs ?? [];
  const acceptedCount = proposals?.filter((p) => p._accepted).length ?? 0;

  return (
    <div className="study-dialog" role="dialog" aria-label="Generate cards">
      <div className="study-dialog__body study-dialog__body--wide">
        <h3>Generate cards</h3>
        {proposals === null ? (
          <>
            <p>Draft flashcards from what this workspace knows — you review every one before it lands.
              {sources ? <> Ordered for the <strong>{sources.profile}</strong> profile.</> : null}</p>
            <div className="study-srcpick">
              {(sources?.sources ?? []).map((s) => (
                <button key={s.kind} className={`study-srcpick__btn ${kind === s.kind ? 'is-on' : ''}`} onClick={() => setKind(s.kind)}>
                  <strong>{s.label}</strong><span>{s.hint}</span>
                </button>
              ))}
            </div>
            {kind === 'text' ? (
              <textarea className="study-input" rows={7} value={text} autoFocus
                placeholder="Paste notes, an article, a transcript…" onChange={(e) => setText(e.target.value)} />
            ) : needsPath ? (
              <select className="study-input" value={pickedPath} onChange={(e) => setPickedPath(e.target.value)}>
                <option value="">Choose a {kind === 'decisions' ? 'decision record' : 'document'}…</option>
                {pathOptions.map((d) => <option key={d.path} value={d.path}>{d.title}</option>)}
              </select>
            ) : (
              <p className="study-srcpick__note">Cards will be drawn from the codebase map (build one with <code>/atlas</code> first).</p>
            )}
            {error ? <p className="study-error">{error}</p> : null}
            <div className="study-dialog__actions">
              <button className="study-btn" onClick={props.onClose}>Cancel</button>
              <button className="study-btn study-btn--primary" disabled={busy || (needsPath && !pickedPath) || (kind === 'text' && !text.trim())}
                onClick={generate}>{busy ? 'Generating…' : 'Generate'}</button>
            </div>
          </>
        ) : (
          <>
            <p>{proposals.length} proposed — untick any you don’t want, edit inline, then add. Each keeps a link to its source.</p>
            <ol className="study-tray">
              {proposals.map((p, idx) => (
                <li key={idx} className={`study-tray__row ${p._accepted ? '' : 'is-rejected'}`}>
                  <input type="checkbox" checked={p._accepted}
                    onChange={(e) => setProposals((ps) => ps!.map((q, i) => i === idx ? { ...q, _accepted: e.target.checked } : q))} />
                  <div className="study-tray__cells">
                    <input className="study-input" value={p.front}
                      onChange={(e) => setProposals((ps) => ps!.map((q, i) => i === idx ? { ...q, front: e.target.value } : q))} />
                    <input className="study-input" value={p.back}
                      onChange={(e) => setProposals((ps) => ps!.map((q, i) => i === idx ? { ...q, back: e.target.value } : q))} />
                  </div>
                  {p.provenance && p.provenance.kind !== 'manual'
                    ? <span className="study-src" title="Source">{p.provenance.kind}</span> : null}
                </li>
              ))}
            </ol>
            {error ? <p className="study-error">{error}</p> : null}
            <div className="study-dialog__actions">
              <button className="study-btn" onClick={() => setProposals(null)}>← Back</button>
              <button className="study-btn study-btn--primary" disabled={acceptedCount === 0}
                onClick={() => props.onAccept(proposals.filter((p) => p._accepted).map(({ _accepted, ...p }) => { void _accepted; return p; }))}>
                Add {acceptedCount} card{acceptedCount === 1 ? '' : 's'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- review session --------------------------------------------------------

type ReviewMode = 'flip' | 'choice' | 'type';
const REVIEW_MODES: { id: ReviewMode; label: string }[] = [
  { id: 'flip', label: 'Flip' }, { id: 'choice', label: 'Choice' }, { id: 'type', label: 'Type' },
];

/** Character-level diff of a typed answer vs the expected answer, as spans. */
function diffAnswer(typed: string, expected: string): { correct: boolean; nodes: React.ReactNode } {
  const t = typed.trim();
  const e = expected.trim();
  const correct = t.toLowerCase() === e.toLowerCase();
  if (correct) return { correct, nodes: <span className="study-diff__ok">{e}</span> };
  // Show the expected answer with the shared prefix/suffix marked, the middle wrong.
  let pre = 0;
  while (pre < t.length && pre < e.length && t[pre]!.toLowerCase() === e[pre]!.toLowerCase()) pre++;
  let suf = 0;
  while (suf < e.length - pre && suf < t.length - pre && e[e.length - 1 - suf]!.toLowerCase() === t[t.length - 1 - suf]!.toLowerCase()) suf++;
  const okStart = e.slice(0, pre);
  const wrong = e.slice(pre, e.length - suf);
  const okEnd = e.slice(e.length - suf);
  return {
    correct,
    nodes: <>
      <span className="study-diff__ok">{okStart}</span>
      <span className="study-diff__miss">{wrong}</span>
      <span className="study-diff__ok">{okEnd}</span>
    </>,
  };
}

function ReviewSession(props: { deckId: string; deckName: string; onDone: () => void }): React.JSX.Element {
  const [queue, setQueue] = useState<ReviewItem[] | null>(null);
  const [pos, setPos] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [graded, setGraded] = useState(0);
  const [reviewMode, setReviewMode] = useState<ReviewMode>('flip');
  const [picked, setPicked] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const againRef = useRef<ReviewItem[]>([]);

  useEffect(() => {
    bridgeQuery<SessionResult>('study:session', { id: props.deckId })
      .then((r) => setQueue(r.items))
      .catch(() => setQueue([]));
  }, [props.deckId]);

  const current = queue?.[pos];

  const advance = useCallback((requeue: ReviewItem | null) => {
    setRevealed(false);
    setPicked(null);
    setTyped('');
    setQueue((q) => {
      if (!q) return q;
      const next = requeue ? [...q, requeue] : q;
      return next;
    });
    setPos((p) => p + 1);
  }, []);

  const grade = useCallback((g: StudyGrade) => {
    if (!current) return;
    setGraded((n) => n + 1);
    bridgeQuery('study:grade', { deckId: props.deckId, cardId: current.card.id, grade: g }).catch(() => {});
    // `again` re-queues the card later THIS sitting (day-granularity persistence
    // schedules it for tomorrow; the live session still drills it now).
    advance(g === 'again' ? current : null);
  }, [current, advance, props.deckId]);

  // Keyboard: space/enter reveals; 1–4 grade.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); setRevealed(true); return; }
      if (revealed && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); grade(GRADES[Number(e.key) - 1]!); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, revealed, grade]);

  if (!queue) return <div className="study-empty" aria-busy="true" />;

  if (!current) {
    return (
      <div className="study-review study-review--done">
        <div className="study-done">
          <h2>Session complete</h2>
          <p>{graded} review{graded === 1 ? '' : 's'} in “{props.deckName}”. Come back when more cards are due.</p>
          <button className="study-btn study-btn--primary" onClick={props.onDone}>Back to decks</button>
        </div>
      </div>
    );
  }

  const remaining = queue.length - pos;
  void againRef;
  const canMc = reviewMode === 'choice' && current.mc.options.length >= 2;
  const typedDiff = revealed && reviewMode === 'type' ? diffAnswer(typed, current.card.back) : null;

  return (
    <div className="study-review">
      <header className="study-review__head">
        <button className="study-btn study-btn--ghost" onClick={props.onDone}>← End</button>
        <div className="study-review__meta">
          <span>{props.deckName}</span>
          <span className="study-review__count">{remaining} left{current.isNew ? ' · new card' : ''}</span>
          <div className="study-modeswitch" role="tablist" aria-label="Review format">
            {REVIEW_MODES.map((m) => (
              <button key={m.id} role="tab" aria-selected={reviewMode === m.id}
                className={`study-modeswitch__btn ${reviewMode === m.id ? 'is-on' : ''}`}
                onClick={() => { setReviewMode(m.id); setRevealed(false); setPicked(null); setTyped(''); }}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className={`study-card ${revealed ? 'is-revealed' : ''}`}
        onClick={() => reviewMode === 'flip' && !revealed && setRevealed(true)}>
        <div className="study-card__front">{renderFront(current.card)}</div>

        {reviewMode === 'choice' && canMc ? (
          <div className="study-choices">
            {current.mc.options.map((opt, idx) => {
              const isAnswer = idx === current.mc.correctIndex;
              const state = picked === null ? '' : isAnswer ? 'is-correct' : idx === picked ? 'is-wrong' : '';
              return (
                <button key={idx} className={`study-choice ${state}`} disabled={picked !== null}
                  onClick={() => { setPicked(idx); setRevealed(true); }}>
                  {opt}
                </button>
              );
            })}
          </div>
        ) : reviewMode === 'type' ? (
          revealed ? (
            <div className="study-typed">
              <div className={`study-typed__result ${typedDiff?.correct ? 'is-ok' : 'is-miss'}`}>
                {typedDiff?.correct ? '✓ Correct' : 'Expected:'} {typedDiff?.nodes}
              </div>
              {!typedDiff?.correct && typed.trim() ? <div className="study-typed__yours">You typed: {typed}</div> : null}
            </div>
          ) : (
            <form className="study-typed" onSubmit={(e) => { e.preventDefault(); setRevealed(true); }}>
              <input className="study-input" autoFocus placeholder="Type the answer, then Enter"
                value={typed} onChange={(e) => setTyped(e.target.value)} />
            </form>
          )
        ) : revealed ? (
          <>
            <hr className="study-card__rule" />
            <div className="study-card__back">{current.card.back || <em>(no answer text)</em>}</div>
          </>
        ) : (
          <div className="study-card__hint">Click or press Space to reveal</div>
        )}
      </div>

      {revealed ? (
        <div className="study-grades">
          {GRADES.map((g, i) => (
            <button key={g} className={`study-grade study-grade--${g}`} onClick={() => grade(g)}>
              <span className="study-grade__key">{i + 1}</span>
              <span className="study-grade__label">{GRADE_LABEL[g]}</span>
              <span className="study-grade__int">{fmtInterval(current.previews[g])}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="study-grades study-grades--hint">
          {reviewMode === 'flip'
            ? <button className="study-btn study-btn--primary" onClick={() => setRevealed(true)}>Reveal answer</button>
            : reviewMode === 'type'
              ? <button className="study-btn study-btn--primary" onClick={() => setRevealed(true)}>Check</button>
              : <span className="study-card__hint">Pick an answer</span>}
        </div>
      )}
    </div>
  );
}

function renderFront(card: StudyCard): React.ReactNode {
  if (card.format !== 'cloze') return card.front;
  // Blank the {{...}} spans for the prompt.
  return card.front.split(/(\{\{[^}]*\}\})/g).map((part, i) =>
    /^\{\{[^}]*\}\}$/.test(part) ? <span key={i} className="study-cloze">[…]</span> : <React.Fragment key={i}>{part}</React.Fragment>);
}
