/**
 * Reviewed workspace setup editor.
 *
 * The renderer can select and edit a complete manifest draft, but it never
 * reads or writes project files directly. Save carries the opaque revision
 * returned by main so the host can reject stale or cross-workspace commits.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  draftFromOnboardingProfile,
  onboardingDraftPreview,
  onboardingSavePayload,
  parseOnboardingCsv,
  parseOnboardingEditor,
  type LoadedOnboardingEditor,
  type OnboardingDraft,
  type OnboardingProfile,
} from './onboardingEditorModel.js';

export function OnboardingDialog({ root, onClose, onSaved }: {
  root: string | null;
  onClose: () => void;
  onSaved?: (root: string) => void;
}): React.ReactElement | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestGeneration = useRef(0);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(false);
  const [editor, setEditor] = useState<LoadedOnboardingEditor | null>(null);
  const [draft, setDraft] = useState<OnboardingDraft | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  onCloseRef.current = onClose;
  savingRef.current = saving;

  const load = (workspaceRoot: string, staleMessage = ''): void => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setSaving(false);
    setError('');
    setNotice('');
    setEditor(null);
    setDraft(null);
    const request = window.brainrouter.workspaceManifest?.(workspaceRoot);
    if (!request) {
      setError('Workspace setup is unavailable.');
      setLoading(false);
      return;
    }
    void request.then((raw) => {
      if (generation !== requestGeneration.current || root !== workspaceRoot) return;
      const loaded = parseOnboardingEditor(raw);
      if (!loaded) {
        const message = raw && typeof raw === 'object' && 'error' in raw
          ? String((raw as { error?: unknown }).error ?? '')
          : '';
        setError(message || 'Workspace setup is unavailable.');
        setLoading(false);
        return;
      }
      setEditor(loaded);
      setDraft(loaded.draft);
      setNotice(staleMessage);
      setLoading(false);
    }).catch(() => {
      if (generation === requestGeneration.current) {
        setError('Workspace setup is unavailable.');
        setLoading(false);
      }
    });
  };

  useEffect(() => {
    if (!root) return;
    load(root);
    return () => { requestGeneration.current += 1; };
    // The generation guard owns request lifetime; load refreshes only when the
    // selected workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  useEffect(() => {
    if (!root || loading || !draft) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialogRef.current;
    node?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !savingRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [Boolean(draft), loading, root]);

  const preview = useMemo(() => draft ? onboardingDraftPreview(draft) : '', [draft]);
  if (!root) return null;
  const workspaceName = root.split(/[\\/]/).filter(Boolean).at(-1) || 'workspace';
  const editing = editor ? editor.existing !== null : false;

  const chooseProfile = (profile: OnboardingProfile): void => {
    const replacement = draftFromOnboardingProfile(profile);
    if (!replacement) return;
    setDraft(replacement);
    setNotice('Preset applied. Review and edit every field before saving.');
    setError('');
  };

  const save = (): void => {
    if (!root || !draft || !editor || saving) return;
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError('');
    setNotice('Saving the reviewed workspace setup…');
    const payload = onboardingSavePayload({
      draft,
      revision: editor.revision,
      source: 'wizard',
    });
    const request = window.brainrouter.saveWorkspaceManifest?.(root, payload);
    if (!request) {
      setSaving(false);
      setError('Could not save the workspace setup.');
      return;
    }
    void request.then((result) => {
      if (generation !== requestGeneration.current) return;
      if (result?.saved) {
        onClose();
        onSaved?.(root);
        return;
      }
      if (result?.stale) {
        load(root, 'The workspace changed while this dialog was open. The latest setup has been reloaded.');
        return;
      }
      setSaving(false);
      setError(String(result?.error ?? 'Could not save the workspace setup.'));
    }).catch(() => {
      if (generation === requestGeneration.current) {
        setSaving(false);
        setError('Could not save the workspace setup.');
      }
    });
  };

  const patchDraft = (patch: Partial<OnboardingDraft>): void => {
    setDraft((current) => current ? { ...current, ...patch } : current);
  };

  return (
    <div className="overlay onboard-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <div ref={dialogRef} className="dialog onboard-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={loading || saving}>
        <div className="dialog-title" id={titleId}>{editing ? 'Workspace settings' : `Set up ${workspaceName}`}</div>
        <div className="set-desc" id={descriptionId}>
          Choose a preset, then review every field before saving. Frontend stays an engineer capability and
          activates only for relevant tasks. Nothing is written until you finish setup.
        </div>

        {loading || !draft || !editor ? (
          <div className="onboard-loading"><span className="spinner sm" /> Loading workspace setup…</div>
        ) : (
          <div className="onboard-scroll">
            <section className="onboard-section" aria-labelledby={`${titleId}-profile`}>
              <h3 id={`${titleId}-profile`}>Profile preset</h3>
              <div className="onboard-grid">
                {editor.profiles.map((profile) => (
                  <button type="button" key={profile.id}
                    className={`onboard-card${draft.profile === profile.id ? ' selected' : ''}`}
                    aria-pressed={draft.profile === profile.id}
                    onClick={() => chooseProfile(profile)}>
                    <span className="onboard-card-label">
                      {profile.label}
                      {editor.detected?.profile === profile.id ? <span className="onboard-detected">detected</span> : null}
                    </span>
                    <span className="onboard-card-desc">{profile.description}</span>
                  </button>
                ))}
              </div>
              {editor.detected?.reasons.length ? <div className="onboard-reasons">{editor.detected.reasons.join('; ')}</div> : null}
            </section>

            <section className="onboard-section onboard-fields" aria-labelledby={`${titleId}-details`}>
              <h3 id={`${titleId}-details`}>Agents, capabilities, skills, and tools</h3>
              <TextField label="Default domain agent" value={draft.agents.default}
                hint="Use engineer for software work; frontend is activated as a task-specific capability."
                onChange={(value) => patchDraft({ agents: { ...draft.agents, default: value } })} />
              <ListField label="Enabled agents" values={draft.agents.enabled}
                onChange={(values) => patchDraft({ agents: { ...draft.agents, enabled: values } })} />
              <ListField label="Available capabilities" values={draft.capabilities.enabled}
                hint="Available for task-time activation; not injected on every turn."
                onChange={(values) => patchDraft({ capabilities: { ...draft.capabilities, enabled: values } })} />
              <ListField label="Disabled capabilities" values={draft.capabilities.disabled}
                onChange={(values) => patchDraft({ capabilities: { ...draft.capabilities, disabled: values } })} />
              <ListField label="Skill packs" values={draft.skills.packs}
                onChange={(values) => patchDraft({ skills: { ...draft.skills, packs: values } })} />
              <ListField label="Enabled skills" values={draft.skills.enabled}
                onChange={(values) => patchDraft({ skills: { ...draft.skills, enabled: values } })} />
              <ListField label="Disabled skills" values={draft.skills.disabled}
                onChange={(values) => patchDraft({ skills: { ...draft.skills, disabled: values } })} />
              <ListField label="Tool profiles" values={draft.tools.profiles}
                onChange={(values) => patchDraft({ tools: { ...draft.tools, profiles: values } })} />
              <ListField label="Denied tools" values={draft.tools.deny}
                onChange={(values) => patchDraft({ tools: { ...draft.tools, deny: values } })} />
              <ListField label="Memory tags" values={draft.memory.tags}
                onChange={(values) => patchDraft({ memory: { ...draft.memory, tags: values } })} />
              <TextField label="Memory capture hint" value={draft.memory.captureHint}
                onChange={(value) => patchDraft({ memory: { ...draft.memory, captureHint: value } })} />
              <TextField label="Instruction file" value={draft.instructions}
                hint="Project-relative pointer; generated instruction proposals are limited to AGENT.md."
                onChange={(value) => patchDraft({ instructions: value })} />
            </section>

            <section className="onboard-section" aria-labelledby={`${titleId}-review`}>
              <h3 id={`${titleId}-review`}>Review file changes</h3>
              <div className="onboard-diff-label">
                <span>{editing ? 'Update' : 'Create'} .brainrouter/workspace.json</span>
                <span>{preview.length} characters</span>
              </div>
              <pre className="onboard-diff">{preview}</pre>
              <div className="onboard-no-instruction">No instruction-file change is included.</div>
            </section>
          </div>
        )}

        <div className="onboard-status" aria-live="polite" aria-atomic="true">
          {error ? <span className="onboard-error">{error}</span> : notice ? <span>{notice}</span> : null}
        </div>
        <div className="dialog-actions">
          <button type="button" className="deny" disabled={saving} onClick={onClose}>
            {editing ? 'Cancel' : 'Skip for now'}
          </button>
          <button type="button" className="approve" disabled={!draft || !editor || loading || saving} onClick={save}>
            {saving ? 'Saving…' : editing ? 'Save workspace settings' : 'Finish setup'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TextField({ label, value, hint, onChange }: {
  label: string;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <label className="onboard-field">
      <span>{label}</span>
      <input value={value} maxLength={32_768} onChange={(event) => onChange(event.target.value)} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function ListField({ label, values, hint, onChange }: {
  label: string;
  values: string[];
  hint?: string;
  onChange: (values: string[]) => void;
}): React.ReactElement {
  return <TextField label={label} value={values.join(', ')} hint={hint}
    onChange={(value) => onChange(parseOnboardingCsv(value))} />;
}
