/** Searchable catalog controls and the Core-derived plan/effective-access card. */
import React, { useState } from 'react';
import {
  type OnboardingCatalogKind,
  type OnboardingCatalogRow,
  type OnboardingPlanPreview,
} from './onboardingCatalogModel.js';

export function CatalogField({ label, values, kinds, preview, allowBlocked = false, hideUnavailable = false, disabled = false, emptyLabel, onChange }: {
  label: string;
  values: string[];
  kinds: OnboardingCatalogKind[];
  preview: OnboardingPlanPreview | null;
  allowBlocked?: boolean;
  hideUnavailable?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  onChange: (values: string[]) => void;
}): React.ReactElement {
  const [filter, setFilter] = useState('');
  const kindSet = new Set(kinds);
  const query = filter.trim().toLowerCase();
  const rows = (preview?.catalog ?? [])
    .filter((row) => kindSet.has(row.kind) && row.persistable)
    .filter((row) => !(row.kind === 'skill-pack' && row.managedByCapability))
    .filter((row) => !hideUnavailable || row.selectable || values.includes(row.id))
    .filter((row) => !query || `${row.label} ${row.id} ${row.description} ${row.provenance}`
      .toLowerCase().includes(query));
  const selected = new Set(values);
  const toggle = (row: OnboardingCatalogRow): void => {
    if (disabled || (!selected.has(row.id) && !allowBlocked && !row.selectable)) return;
    onChange(selected.has(row.id)
      ? values.filter((id) => id !== row.id)
      : [...values, row.id]);
  };
  return (
    <details className="onboard-catalog-field">
      <summary>
        <span>{label}</span>
        <span>{values.length} selected</span>
      </summary>
      <div className="onboard-catalog-panel">
        <input type="search" value={filter} disabled={disabled}
          aria-label={`Filter ${label}`}
          placeholder={`Filter ${label.toLowerCase()}…`}
          onChange={(event) => setFilter(event.target.value)} />
        <div className="onboard-catalog-options">
          {rows.length ? rows.map((row) => {
            const checked = selected.has(row.id);
            const blocked = !row.selectable;
            return (
              <label key={`${row.kind}:${row.id}`}
                className={`onboard-catalog-option${checked ? ' selected' : ''}${blocked ? ' blocked' : ''}`}>
                <input type="checkbox" checked={checked}
                  disabled={disabled || (!checked && !allowBlocked && blocked)}
                  onChange={() => toggle(row)} />
                <span>
                  <strong>{row.label}</strong>
                  <small>
                    {row.recommended ? 'Recommended · ' : ''}
                    {row.source} · {row.provenance}
                    {row.expandsTo.length ? ` · Includes ${row.expandsTo.join(', ')}` : ''}
                    {row.blockedReason ? ` · Unavailable: ${row.blockedReason}` : ''}
                  </small>
                  <small>{row.description}</small>
                </span>
              </label>
            );
          }) : <div className="onboard-catalog-empty">
            {emptyLabel ?? 'No catalog choices match this filter.'}
          </div>}
        </div>
      </div>
    </details>
  );
}

export function PlanPreviewCard({ preview, loading }: {
  preview: OnboardingPlanPreview | null;
  loading: boolean;
}): React.ReactElement {
  const strategy = preview?.plan?.strategies.find(
    (candidate) => candidate.id === preview.plan?.selectedStrategyId,
  );
  return (
    <section className="onboard-section onboard-plan-preview" aria-label="Orchestration plan preview">
      <div className="onboard-plan-heading">
        <h3>Plan and effective access</h3>
        {loading ? <span><span className="spinner sm" /> Updating…</span> : null}
      </div>
      {!preview?.plan ? (
        <p>Choose a valid workspace profile to preview its orchestration plan.</p>
      ) : (
        <>
          <div className="onboard-plan-title">
            <strong>{preview.plan.displayName}</strong>
            <span>
              {preview.plan.mode} · {preview.plan.source.provenance}
              {' '}· fallback {preview.plan.selectedStrategyId}
            </span>
          </div>
          <div className="onboard-stage-list">
            {(strategy?.stages ?? []).map((stage, index) => (
              <React.Fragment key={stage.id}>
                {index ? <span aria-hidden="true">→</span> : null}
                <span className="onboard-stage">
                  <strong>{stage.id}</strong>
                  <small>{stage.executorKind === 'primary' ? 'primary' : stage.roleId}{stage.optional ? ' · optional' : ''}</small>
                </span>
              </React.Fragment>
            ))}
          </div>
          <dl className="onboard-effective-grid">
            <div><dt>Roles</dt><dd>{formatEffective(preview.roles.effective)}</dd></div>
            <div><dt>Skills</dt><dd>{formatEffective(preview.skills.effective)}</dd></div>
            <div><dt>Tools</dt><dd>{formatEffective([
              ...preview.tools.effectiveToolIds,
              ...preview.tools.effectiveExtensionIds.map((id) => `extension:${id}`),
            ])}</dd></div>
            <div><dt>Max parallel</dt><dd>{preview.ceilings.effectiveMaxParallel}
              {' '}<span>(plan {preview.ceilings.planMaxParallel}, workspace {preview.ceilings.manifestMaxParallel})</span>
            </dd></div>
          </dl>
        </>
      )}
    </section>
  );
}

function formatEffective(values: string[]): string {
  return values.join(', ') || 'None';
}
