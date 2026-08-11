/**
 * ADR-029 A3/A4 + F3 — the embed block, rendering its target live.
 *
 * The block's text is one workspace reference and what is drawn is the target's
 * CURRENT state, resolved through the same `workspace-resolve` the agent's verbs
 * use (C3: one vocabulary or none). Nothing about the target is stored on the
 * block — A3's whole argument is that a snapshot produces documents that are
 * quietly wrong, and a note repeating a task's old title is worse than one
 * showing an empty box, because the reader believes it.
 *
 * **The states that are not `found` read as sentences.** Gone, denied and
 * unavailable each render core's own wording (A4 centralises it so six modes
 * cannot write six different "you may not see this" strings), and none of them
 * renders as nothing.
 *
 * Picking a target reuses the `@` mention candidates rather than a second list,
 * so an embed can address every mode a mention can — E5's point that dropping
 * cross-mode addressing to match another app exactly would be copying a
 * limitation.
 */
import React, { useEffect, useState } from 'react';
import { Icon } from './Icon.js';
import {
  EMBED_EMPTY_INVITATION, embedRetryLabel, embedState,
  type WorkspaceResolutionDto,
} from './embedView.js';
import type { MentionCandidate } from './mentionPicker.js';
import type { NotesLiveReferenceCapability } from './capabilities.js';

export interface EmbedBlockOps {
  /** A3 — read now, never stored on the link. */
  liveReferences?: NotesLiveReferenceCapability;
  /** E5 — the same candidates the `@` picker offers, so both address every mode. */
  searchMentions: (query: string) => Promise<MentionCandidate[]>;
  /** The reference IS the block's text, so setting it is one ordinary write. */
  setText: (id: string, text: string) => void;
  /** Following it leaves this mode, which only the shell can do. */
  openRef: (uri: string) => void;
}

export function EmbedBlock({ blockId, text, readOnly, ops }: {
  blockId: string;
  text: string;
  readOnly: boolean;
  ops: EmbedBlockOps;
}): React.ReactElement {
  const [answer, setAnswer] = useState<WorkspaceResolutionDto | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [picking, setPicking] = useState(false);
  const uri = (text ?? '').trim();
  const state = embedState(uri, answer);

  useEffect(() => {
    setAnswer(null);
    if (state.state === 'empty' || state.state === 'not-a-reference') return;
    if (!ops.liveReferences) {
      setAnswer({ resolution: { status: 'unavailable' }, line: 'This host cannot resolve live references.' });
      return;
    }
    let cancelled = false;
    void ops.liveReferences.resolve(uri).then((next) => {
      if (cancelled) return;
      // A host that could not answer is `unavailable`, not `gone`: telling
      // someone their task was deleted because the bridge hiccupped is the
      // accusation A3 rules out.
      setAnswer(next ?? { resolution: { status: 'unavailable' }, line: 'This link could not be read here.' });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, attempt]);

  if (state.state === 'empty' || picking || state.state === 'not-a-reference') {
    return (
      <div className="notes-embed is-empty">
        {state.state === 'not-a-reference' ? <div className="notes-embed-note">{state.note}</div> : null}
        {readOnly ? (
          <span className="notes-embed-note">Another device is editing this block.</span>
        ) : (
          <>
            <span className="notes-embed-note">{EMBED_EMPTY_INVITATION}</span>
            <EmbedPicker
              search={ops.searchMentions}
              onPick={(picked) => { ops.setText(blockId, picked); setPicking(false); }}
            />
          </>
        )}
      </div>
    );
  }

  const retry = state.state === 'unresolved' ? embedRetryLabel(state.status) : null;

  return (
    <div className="notes-embed" data-status={state.state === 'found' ? 'found' : state.state}>
      <div className="notes-embed-card">
        <span className="notes-embed-mode">
          {state.state === 'found' ? state.mode : 'link'}
        </span>
        {state.state === 'found' ? (
          <button className="notes-embed-open" onClick={() => ops.openRef(state.uri)} title={state.uri}>
            {state.label}
          </button>
        ) : (
          // The sentence, not a box. `gone`, `denied` and `unavailable` all land
          // here and all say what happened.
          <span className="notes-embed-line">{state.state === 'loading' ? state.label : state.note}</span>
        )}
      </div>

      {readOnly ? null : (
        <div className="notes-embed-tools">
          {retry ? (
            <button className="notes-embed-btn" onClick={() => setAttempt((n) => n + 1)}>
              <Icon name="refresh" size={11} /> {retry}
            </button>
          ) : null}
          <button className="notes-embed-btn" onClick={() => setPicking(true)}>
            <Icon name="edit" size={11} /> Point it somewhere else
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The target picker.
 *
 * Filtered by the same ranking the `@` menu uses — the candidates arrive already
 * ranked from `mentionCandidates`, so the two menus cannot order the same few
 * characters differently, which is the kind of difference nobody can explain and
 * everybody notices.
 */
function EmbedPicker({ search, onPick }: {
  search: (query: string) => Promise<MentionCandidate[]>;
  onPick: (uri: string) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MentionCandidate[]>([]);

  useEffect(() => {
    let cancelled = false;
    void search(query).then((next) => { if (!cancelled) setRows(next.slice(0, 8)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="notes-embed-picker">
      <input
        className="filter" autoFocus placeholder="A task, a note, a meeting…"
        value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // A reference somebody pasted is as good as one they picked, and
          // refusing it would make the picker the only way in.
          if (event.key === 'Enter' && query.trim().startsWith('brainrouter://')) onPick(query.trim());
        }}
      />
      {rows.map((row) => (
        <button key={row.uri} className="notes-embed-row" onClick={() => onPick(row.uri)}>
          <span className="notes-embed-row-label">{row.label}</span>
          {/* The mode, so two records called `BR-1` in different modes stay
              apart — the same disambiguation the `@` menu shows. */}
          <small>{row.mode}</small>
        </button>
      ))}
      {rows.length === 0 ? (
        <span className="notes-embed-note">Nothing matches. A brainrouter:// address works too.</span>
      ) : null}
    </div>
  );
}
