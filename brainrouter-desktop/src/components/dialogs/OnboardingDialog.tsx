/**
 * Reviewed workspace setup editor.
 *
 * The renderer can select and edit a complete manifest draft, but it never
 * reads or writes project files directly. Save carries the opaque revision
 * returned by main so the host can reject stale or cross-workspace commits.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import {
  draftFromOnboardingProfile,
  onboardingDescriptionError,
  onboardingDraftPreview,
  onboardingProposalStatus,
  onboardingSavePayload,
  parseOnboardingCsv,
  parseOnboardingEditor,
  parseOnboardingProposal,
  ONBOARDING_DESCRIPTION_MAX_BYTES,
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
  const busyRef = useRef(false);
  const [editor, setEditor] = useState<LoadedOnboardingEditor | null>(null);
  const [draft, setDraft] = useState<OnboardingDraft | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [description, setDescription] = useState('');
  const [saveSource, setSaveSource] = useState<'wizard' | 'agent'>('wizard');
  const [instructionOffered, setInstructionOffered] = useState(false);
  onCloseRef.current = onClose;
  busyRef.current = saving || proposing;

  const load = (workspaceRoot: string, staleMessage = ''): void => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setSaving(false);
    setProposing(false);
    setDescription('');
    setSaveSource('wizard');
    setInstructionOffered(false);
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
    node?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
  const descriptionBytes = useMemo(() => new TextEncoder().encode(description.trim()).length, [description]);
  const descriptionProblem = useMemo(() => onboardingDescriptionError(description), [description]);
  if (!root) return null;
  const workspaceName = root.split(/[\\/]/).filter(Boolean).at(-1) || 'workspace';
  const editing = editor ? editor.existing !== null : false;

  const chooseProfile = (profile: OnboardingProfile): void => {
    const replacement = draftFromOnboardingProfile(profile);
    if (!replacement) return;
    setDraft(replacement);
    setSaveSource('wizard');
    setInstructionOffered(false);
    setNotice('Preset applied. Review and edit every field before saving.');
    setError('');
  };

  const propose = (): void => {
    if (!root || !editor || proposing || saving) return;
    if (descriptionProblem) {
      setError(descriptionProblem);
      return;
    }
    const workspaceRoot = root;
    const generation = ++requestGeneration.current;
    setProposing(true);
    setError('');
    setNotice('Scanning the project and preparing a reviewable proposal…');
    void bridgeQuery<unknown>(
      'workspace-onboarding-propose',
      { description: description.trim() },
      25_000,
      workspaceRoot,
    ).then((raw) => {
      if (generation !== requestGeneration.current || root !== workspaceRoot) return;
      const proposal = parseOnboardingProposal(raw);
      if (!proposal) {
        setError('The workspace proposal was incomplete. Try again or continue with the manual presets.');
        setNotice('');
        setProposing(false);
        return;
      }
      setDraft(proposal.draft);
      setSaveSource(proposal.source);
      setInstructionOffered(proposal.instruction !== null);
      setNotice(onboardingProposalStatus(proposal));
      setError('');
      setProposing(false);
    }).catch(() => {
      if (generation !== requestGeneration.current || root !== workspaceRoot) return;
      setProposing(false);
      setNotice('');
      setError('Could not prepare the workspace proposal. Try again or continue with the manual presets.');
    });
  };

  const save = (): void => {
    if (!root || !draft || !editor || saving || proposing) return;
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError('');
    setNotice('Saving the reviewed workspace setup…');
    const payload = onboardingSavePayload({
      draft,
      revision: editor.revision,
      source: saveSource,
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
      if (event.target === event.currentTarget && !saving && !proposing) onClose();
    }}>
      <div ref={dialogRef} className="dialog onboard-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={loading || saving || proposing}>
        <div className="dialog-title" id={titleId}>{editing ? 'Workspace settings' : `Set up ${workspaceName}`}</div>
        <div className="set-desc" id={descriptionId}>
          Choose a preset, then review every field before saving. Frontend stays an engineer capability and
          activates only for relevant tasks. Nothing is written until you finish setup.
        </div>

        {loading || !draft || !editor ? (
          <div className="onboard-loading"><span className="spinner sm" /> Loading workspace setup…</div>
        ) : (
          <div className="onboard-scroll">
            <section className="onboard-section onboard-assist" aria-labelledby={`${titleId}-assist`}>
              <div className="onboard-assist-heading">
                <div>
                  <h3 id={`${titleId}-assist`}>Describe your project</h3>
                  <p>Use the active managed model and a bounded repository scan to prepare every workspace field for review.</p>
                </div>
                <button type="button" className="approve" disabled={proposing || saving || Boolean(descriptionProblem)}
                  onClick={propose}>
                  {proposing ? 'Preparing…' : 'Set up with AI'}
                </button>
              </div>
              <label className="onboard-assist-input">
                <span>What are you building, and how should the agents help?</span>
                <textarea value={description} disabled={proposing || saving} maxLength={ONBOARDING_DESCRIPTION_MAX_BYTES}
                  placeholder="For example: A responsive TypeScript dashboard with an API, tests, and accessible UI."
                  onChange={(event) => { setDescription(event.target.value); setError(''); }} />
                <small className={descriptionProblem ? 'onboard-error' : ''}>
                  {descriptionProblem ?? `${descriptionBytes} / ${ONBOARDING_DESCRIPTION_MAX_BYTES} UTF-8 bytes`}
                </small>
              </label>
              {proposing ? (
                <div className="onboard-assist-progress" role="status">
                  <span className="spinner sm" /> Scanning project signals and preparing the proposal…
                </div>
              ) : null}
            </section>

            <section className="onboard-section" aria-labelledby={`${titleId}-profile`}>
              <h3 id={`${titleId}-profile`}>Profile preset</h3>
              <div className="onboard-grid">
                {editor.profiles.map((profile) => (
                  <button type="button" key={profile.id}
                    className={`onboard-card${draft.profile === profile.id ? ' selected' : ''}`}
                    disabled={proposing || saving}
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
                disabled={proposing || saving}
                hint="Use engineer for software work; frontend is activated as a task-specific capability."
                onChange={(value) => patchDraft({ agents: { ...draft.agents, default: value } })} />
              <ListField label="Enabled agents" values={draft.agents.enabled}
                disabled={proposing || saving}
                onChange={(values) => patchDraft({ agents: { ...draft.agents, enabled: values } })} />
              <ListField label="Available capabilities" values={draft.capabilities.enabled}
                disabled={proposing || saving}
                hint="Available for task-time activation; not injected on every turn."
                onChange={(values) => patchDraft({ capabilities: { ...draft.capabilities, enabled: values } })} />
              <ListField label="Disabled capabilities" values={draft.capabilities.disabled}
                disabled={proposing || saving}
                onChange={(values) => patchDraft({ capabilities: { ...draft.capabilities, disabled: values } })} />
              <ListField label="Skill packs" values={draft.skills.packs}
                disabled={proposing || saving}
                onChange={(values) => patchDraft({ skills: { ...draft.skills, packs: values } })} />
              <ListField label="Enabled skills" values={draft.skills.enabled}
                disabled={proposing || saving}
                onChange={(values) => patchDraft({ skills: { ...draft.skills, enabled: values } })} />
              <ListField label="Disabled skills" values={draft.skills.disabled}
                disabled={proposing || saving}
                onChange={(values) => patchDraft({ skills: { ...draft.skills, disabled: values } })} />
              <ListField label="Tool profiles" values={draft.tools.profiles}
                disabled={proposing || saving}
                onChange={(values) => patchDraft({ tools: { ...draft.tools, profiles: values } })} />
              <ListField label="Denied tools" values={draft.tools.deny}
                disabled={proposing || saving}
                onChange={(values) => patchDraft({ tools: { ...draft.tools, deny: values } })} />
              <ListField label="Memory tags" values={draft.memory.tags}
                disabled={proposing || saving}
                onChange={(values) => patchDraft({ memory: { ...draft.memory, tags: values } })} />
              <TextField label="Memory capture hint" value={draft.memory.captureHint}
                disabled={proposing || saving}
                onChange={(value) => patchDraft({ memory: { ...draft.memory, captureHint: value } })} />
              <TextField label="Instruction file" value={draft.instructions}
                disabled={proposing || saving}
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
              <div className="onboard-no-instruction">
                {instructionOffered
                  ? 'The proposed instruction-file change is not included until its exact diff is reviewed.'
                  : 'No instruction-file change is included.'}
              </div>
            </section>
          </div>
        )}

        <div className="onboard-status" aria-live="polite" aria-atomic="true">
          {error ? <span className="onboard-error">{error}</span> : notice ? <span>{notice}</span> : null}
        </div>
        <div className="dialog-actions">
          <button type="button" className="deny" disabled={saving || proposing} onClick={onClose}>
            {editing ? 'Cancel' : 'Skip for now'}
          </button>
          <button type="button" className="approve" disabled={!draft || !editor || loading || saving || proposing} onClick={save}>
            {saving ? 'Saving…' : editing ? 'Save workspace settings' : 'Finish setup'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TextField({ label, value, hint, disabled = false, onChange }: {
  label: string;
  value: string;
  hint?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <label className="onboard-field">
      <span>{label}</span>
      <input value={value} disabled={disabled} maxLength={32_768} onChange={(event) => onChange(event.target.value)} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function ListField({ label, values, hint, disabled = false, onChange }: {
  label: string;
  values: string[];
  hint?: string;
  disabled?: boolean;
  onChange: (values: string[]) => void;
}): React.ReactElement {
  return <TextField label={label} value={values.join(', ')} hint={hint} disabled={disabled}
    onChange={(value) => onChange(parseOnboardingCsv(value))} />;
}
