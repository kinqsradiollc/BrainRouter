/**
 * Live Variants drawer (ADR-056 D-B5) — the desktop pick-and-cycle loop.
 *
 * Three states in one drawer: PICK an element on the running app, name an
 * action and a count and GENERATE (the agent writes the variants into the
 * source through `design_variants`), then CYCLE the live wrapper and accept
 * one or discard them all. Presentational only — every side effect is a
 * callback the Browser panel owns, so this renders the same in a test as on a
 * real page.
 */
import React from 'react';
import { Icon } from '../../icons.js';
import { cyclerLabel, describeVariantCount, type LiveVariantMode, type LiveVariantScanEntry, type LiveVariantTarget, type VariantPickRow } from '../../lib/browser/liveVariants.js';

const COUNTS = [2, 3, 4, 5, 6] as const;

export interface LiveVariantsDrawerProps {
  mode: LiveVariantMode;
  ready: boolean;
  busy: boolean;
  status: string;
  // pick
  elements: VariantPickRow[];
  loadingElements: boolean;
  onRescanElements: () => void;
  onPick: (row: VariantPickRow) => void;
  // form
  target: LiveVariantTarget | null;
  action: string;
  count: number;
  onSetAction: (value: string) => void;
  onSetCount: (value: number) => void;
  onGenerate: () => void;
  onRepick: () => void;
  // cycle
  cycler: LiveVariantScanEntry | null;
  onPrev: () => void;
  onNext: () => void;
  onAccept: () => void;
  onDiscard: () => void;
  onRescan: () => void;
}

export function LiveVariantsDrawer(props: LiveVariantsDrawerProps): React.ReactElement {
  if (!props.ready && props.mode === 'pick') {
    return <div className="br-empty">Load a page from your dev server to try variants on it.</div>;
  }

  if (props.mode === 'pick') {
    return (
      <div className="br-lv br-lv-pick">
        <div className="br-lv-lead">
          <span>Pick the element you want variations of.</span>
          <button className="chip" onClick={props.onRescanElements} disabled={props.loadingElements}>
            {props.loadingElements ? 'scanning…' : 'rescan'}
          </button>
        </div>
        {props.elements.length ? (
          <div className="br-lv-list">
            {props.elements.map((row) => (
              <button key={row.ref} className="br-lv-el" onClick={() => props.onPick(row)} disabled={props.busy} aria-label={`Make variants of ${row.label}`} title={`Make variants of ${row.label}`}>
                <span className="br-lv-el-tag">{row.tag || row.role}</span>
                <span className="br-lv-el-label">{row.label}</span>
                <Icon name="palette" size={12} className="br-lv-el-go" />
              </button>
            ))}
          </div>
        ) : (
          <div className="br-empty">{props.loadingElements ? 'Scanning the page…' : 'No elements found. Rescan, or interact with the page first.'}</div>
        )}
      </div>
    );
  }

  if (props.mode === 'form') {
    const target = props.target;
    return (
      <div className="br-lv br-lv-form">
        <div className="br-lv-target">
          <Icon name="palette" size={13} className="br-lv-target-icon" />
          <div className="br-lv-target-text">
            <b>{target ? `${target.tag}${target.classes.slice(0, 3).map((c) => `.${c}`).join('')}${target.elementId ? `#${target.elementId}` : ''}` : 'element'}</b>
            {target?.text ? <span className="br-lv-target-quote">“{target.text}”</span> : null}
            {target?.hint?.file ? <span className="br-lv-hint">source: {target.hint.file}{target.hint.line ? `:${target.hint.line}` : ''}</span> : <span className="br-lv-hint muted">no source hint — the agent will search</span>}
          </div>
          <button className="chip ghost" onClick={props.onRepick} disabled={props.busy}>change</button>
        </div>
        <label className="br-lv-field">
          <span>Make it…</span>
          <input
            className="br-type"
            value={props.action}
            placeholder="bolder, quieter, more playful…"
            onChange={(event) => props.onSetAction(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !props.busy) props.onGenerate(); }}
            autoFocus
          />
        </label>
        <div className="br-lv-field">
          <span>How many</span>
          <div className="br-lv-counts" role="radiogroup" aria-label="Number of variants">
            {COUNTS.map((n) => (
              <button key={n} role="radio" aria-checked={props.count === n} className={`br-lv-count${props.count === n ? ' on' : ''}`} onClick={() => props.onSetCount(n)}>{n}</button>
            ))}
          </div>
        </div>
        <div className="br-lv-actions">
          <button className="chip" onClick={props.onRepick} disabled={props.busy}>back</button>
          <button className="br-lv-primary" onClick={props.onGenerate} disabled={props.busy}>
            {props.busy ? 'Writing variants…' : `Generate ${describeVariantCount(props.count)}`}
          </button>
        </div>
        {props.status ? <div className="br-lv-status" role="status">{props.status}</div> : null}
      </div>
    );
  }

  // cycle
  const cycler = props.cycler;
  return (
    <div className="br-lv br-lv-cycle">
      {cycler ? (
        <>
          <div className="br-lv-cycler">
            <button className="br-lv-step" aria-label="Previous variant" onClick={props.onPrev} disabled={props.busy || cycler.count < 2}><Icon name="chev-left" size={16} /></button>
            <div className="br-lv-cycler-mid">
              <b>{cyclerLabel(cycler)}</b>
              <div className="br-lv-dots" aria-hidden>
                {Array.from({ length: cycler.count }, (_, i) => <span key={i} className={`br-lv-dot${i === cycler.active ? ' on' : ''}`} />)}
              </div>
            </div>
            <button className="br-lv-step" aria-label="Next variant" onClick={props.onNext} disabled={props.busy || cycler.count < 2}><Icon name="chev-right" size={16} /></button>
          </div>
          <div className="br-lv-verdict">
            <button className="br-lv-accept" onClick={props.onAccept} disabled={props.busy}><Icon name="check-circle" size={13} /> Keep {cycler.active === 0 ? 'the original' : 'this one'}</button>
            <button className="chip danger" onClick={props.onDiscard} disabled={props.busy}>Discard all</button>
            <button className="chip ghost" onClick={props.onRescan} disabled={props.busy} title="Re-read the page">rescan</button>
          </div>
          <div className="br-lv-note">Cycling only changes what shows. Keep writes the winner into your source; discard restores the file.</div>
        </>
      ) : (
        <div className="br-empty">
          {props.busy ? 'Waiting for the variants to land on the page…' : 'No live variants on this page yet.'}
          <button className="chip" onClick={props.onRescan} disabled={props.busy} style={{ marginLeft: 8 }}>rescan</button>
        </div>
      )}
      {props.status ? <div className="br-lv-status" role="status">{props.status}</div> : null}
    </div>
  );
}
