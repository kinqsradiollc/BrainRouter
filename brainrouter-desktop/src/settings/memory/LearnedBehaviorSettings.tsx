import React, { useEffect, useMemo, useState } from 'react';
import type { LearnedItem, LearnedTenant, LearningLogEntry } from '@kinqs/brainrouter-core/learning';
import { Row, SetGroup } from '../shared/controls.js';
import {
  humanCorrectionDraftState,
  HUMAN_CORRECTION_LIMITS,
  type HumanCorrectionDraft,
} from './humanCorrectionDraft.js';

export interface LearnedBehaviorSnapshot {
  tenant: LearnedTenant;
  items: LearnedItem[];
  log: LearningLogEntry[];
  correctionAllowed: boolean;
  correctionBlockedReason?: string;
  error?: string;
}

function when(value: string | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ItemDetail(props: {
  item: LearnedItem;
  onRevert: (id: string, reason: string) => void;
}): React.ReactElement {
  const { item } = props;
  const [reverting, setReverting] = useState(false);
  const [reason, setReason] = useState('');
  const inactive = item.status === 'retired' || item.status === 'reverted';
  const submit = (): void => {
    const detail = reason.trim();
    if (!detail) return;
    props.onRevert(item.id, detail);
    setReverting(false);
    setReason('');
  };

  return (
    <details className="set-dev-raw">
      <summary className="set-h2" style={{ cursor: 'pointer' }}>
        <span className={`badge ${inactive ? 'dim' : 'native'}`}>{item.status}</span>{' '}
        <span className="badge settings">{item.tier}</span>{' '}
        {item.statement}
      </summary>
      <div className="set-desc" style={{ marginTop: 8 }}>
        <div><b>Form:</b> {item.form} · <b>Origin:</b> {item.origin}</div>
        <div><b>Expected improvement:</b> {item.outcome.expectation}</div>
        <div><b>What would disprove it:</b> {item.falsifier}</div>
        <div><b>Observed:</b> {item.outcome.retrievals} retrievals · {item.outcome.confirmations} confirmations · {item.outcome.contradictions} contradictions</div>
        <div><b>Source:</b> {item.provenance.sessionKey} · {item.provenance.checkpoint} · {when(item.provenance.capturedAt)}</div>
        <div><b>Gate:</b> {item.provenance.gateReasoning}</div>
        {item.provenance.evidence.length > 0 ? (
          <div><b>Evidence:</b><ul>{item.provenance.evidence.map((entry, index) => <li key={`${item.id}-e-${index}`}>{entry}</li>)}</ul></div>
        ) : null}
        {item.statusReason ? <div><b>Status reason:</b> {item.statusReason}</div> : null}
        {item.skillId ? <div><b>Runnable skill:</b> <code>{item.skillId}</code></div> : null}
        {item.memoryRecordId ? <div><b>Memory record:</b> <code>{item.memoryRecordId}</code></div> : null}
      </div>
      {!inactive ? (
        reverting ? (
          <div className="rule-add" style={{ marginTop: 10 }}>
            <input
              className="ctl"
              aria-label={`Reason for reverting ${item.statement}`}
              placeholder="Why should the agent stop using this?"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
            />
            <button className="btn danger" disabled={!reason.trim()} onClick={submit}>Confirm revert</button>
            <button className="btn" onClick={() => { setReverting(false); setReason(''); }}>Cancel</button>
          </div>
        ) : <button className="btn danger" style={{ marginTop: 10 }} onClick={() => setReverting(true)}>Revert this learning</button>
      ) : null}
    </details>
  );
}

export function LearnedBehaviorSettings(props: {
  snapshot?: LearnedBehaviorSnapshot;
  onCorrect: (correction: HumanCorrectionDraft) => void;
  onRevert: (id: string, reason: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<HumanCorrectionDraft>({ statement: '', falsifier: '', expectation: '' });
  const [submitted, setSubmitted] = useState(false);
  const items = props.snapshot?.items ?? [];
  const active = useMemo(
    () => items.filter((item) => item.status === 'active' || item.status === 'demoted').length,
    [items],
  );
  const tenant = props.snapshot?.tenant;
  const prepared = humanCorrectionDraftState(draft);
  const correctionAllowed = props.snapshot?.correctionAllowed === true;
  const blockedReason = props.snapshot?.correctionBlockedReason ?? props.snapshot?.error;
  const scope = tenant
    ? `${tenant.orgId || 'personal'} / ${tenant.userId}`
    : 'current signed-in account';
  useEffect(() => setSubmitted(false), [props.snapshot]);
  const updateDraft = (key: keyof HumanCorrectionDraft, value: string): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSubmitted(false);
  };
  const submitCorrection = (): void => {
    if (!correctionAllowed || !prepared.ready || submitted) return;
    setSubmitted(true);
    props.onCorrect(prepared.fields);
  };

  return (
    <>
      <SetGroup title="Teach a correction">
        <Row
          title="Explicit human instruction"
          desc="This explicit action can create an instruction-tier behavior. Ordinary chat prose remains conversation and is never promoted automatically."
        />
        <div style={{ display: 'grid', gap: 6, padding: '4px 0 8px' }}>
          <label className="set-desc" htmlFor="human-correction-statement">Correction</label>
          <textarea
            id="human-correction-statement"
            className="ctl"
            style={{ width: '100%', boxSizing: 'border-box' }}
            rows={3}
            maxLength={HUMAN_CORRECTION_LIMITS.statement}
            placeholder="What should the agent do differently?"
            value={draft.statement}
            onChange={(event) => updateDraft('statement', event.target.value)}
          />
          <label className="set-desc" htmlFor="human-correction-falsifier">What would disprove it?</label>
          <textarea
            id="human-correction-falsifier"
            className="ctl"
            style={{ width: '100%', boxSizing: 'border-box' }}
            rows={2}
            maxLength={HUMAN_CORRECTION_LIMITS.falsifier}
            placeholder="Name the observable result that would show this correction is wrong."
            value={draft.falsifier}
            onChange={(event) => updateDraft('falsifier', event.target.value)}
          />
          <label className="set-desc" htmlFor="human-correction-expectation">Expected improvement</label>
          <textarea
            id="human-correction-expectation"
            className="ctl"
            style={{ width: '100%', boxSizing: 'border-box' }}
            rows={2}
            maxLength={HUMAN_CORRECTION_LIMITS.expectation}
            placeholder="What should improve when this correction is used?"
            value={draft.expectation}
            onChange={(event) => updateDraft('expectation', event.target.value)}
          />
          {blockedReason ? <div className="set-desc">{blockedReason}</div> : null}
          {!blockedReason && prepared.error && draft.statement + draft.falsifier + draft.expectation
            ? <div className="set-desc">{prepared.error}</div>
            : null}
          <button
            type="button"
            className="btn"
            style={{ justifySelf: 'start' }}
            disabled={!correctionAllowed || !prepared.ready || submitted}
            onClick={submitCorrection}
          >
            {submitted ? 'Recording…' : 'Record correction as instruction'}
          </button>
        </div>
      </SetGroup>
      <SetGroup title="Learned behavior">
        <Row
          title={`${active} active · ${items.length} total`}
          desc={`Tenant: ${scope}. These are behavioural hypotheses and human corrections that can reach future sessions; reverting one also disables its runnable skill and central-memory copy.`}
        />
        {items.length === 0 ? (
          <div className="empty">Nothing learned for this account and organization yet.</div>
        ) : items.map((item) => <ItemDetail key={item.id} item={item} onRevert={props.onRevert} />)}
      </SetGroup>
      <SetGroup title="Learning audit trail" collapsible defaultOpen={false}>
        {(props.snapshot?.log ?? []).length === 0 ? <div className="empty">No learning events yet.</div> : null}
        {(props.snapshot?.log ?? []).slice(0, 100).map((entry, index) => (
          <Row key={`${entry.at}-${entry.itemId ?? 'store'}-${index}`} title={`${entry.op}${entry.itemId ? ` · ${entry.itemId}` : ''}`} desc={`${when(entry.at)} · ${entry.detail}`} />
        ))}
      </SetGroup>
    </>
  );
}
