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
  parseOnboardingPreview,
  type OnboardingPlanPreview,
} from './onboardingCatalogModel.js';
import {
  CatalogChoiceField,
  CatalogField,
  PlanPreviewCard,
} from './OnboardingCatalogFields.js';
import {
  draftFromOnboardingProfile,
  onboardingDescriptionError,
  onboardingDraftPreview,
  onboardingProposalStatus,
  onboardingSavePayload,
  parseOnboardingCsv,
  parseOnboardingEditor,
  parseOnboardingInstructionPreview,
  parseOnboardingProposal,
  ONBOARDING_DESCRIPTION_MAX_BYTES,
  type LoadedOnboardingEditor,
  type OnboardingDraft,
  type OnboardingInstructionDraft,
  type OnboardingProfile,
  type ParsedOnboardingInstructionPreview,
} from './onboardingEditorModel.js';

type ExactInstructionPreview = Extract<ParsedOnboardingInstructionPreview, { ok: true }>;
type InstructionDecision = 'pending' | 'include' | 'exclude' | null;

export function OnboardingDialog({ root, onClose, onSaved }: {
  root: string | null;
  onClose: () => void;
  onSaved?: (root: string) => void;
}): React.ReactElement | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  const [editor, setEditor] = useState<LoadedOnboardingEditor | null>(null);
  const [draft, setDraft] = useState<OnboardingDraft | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [reviewingInstruction, setReviewingInstruction] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [planPreview, setPlanPreview] = useState<OnboardingPlanPreview | null>(null);
  const [description, setDescription] = useState('');
  const [saveSource, setSaveSource] = useState<'wizard' | 'agent'>('wizard');
  const [instructionDraft, setInstructionDraft] = useState<OnboardingInstructionDraft | null>(null);
  const [instructionPreview, setInstructionPreview] = useState<ExactInstructionPreview | null>(null);
  const [instructionDecision, setInstructionDecision] = useState<InstructionDecision>(null);
  onCloseRef.current = onClose;
  busyRef.current = saving || proposing || reviewingInstruction;

  const load = (workspaceRoot: string, staleMessage = ''): void => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setSaving(false);
    setProposing(false);
    setReviewingInstruction(false);
    setDescription('');
    setSaveSource('wizard');
    setInstructionDraft(null);
    setInstructionPreview(null);
    setInstructionDecision(null);
    setError('');
    setNotice('');
    setEditor(null);
    setDraft(null);
    setPlanPreview(null);
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
      setPlanPreview(loaded.preview);
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
    if (!root || !draft || !editor) return;
    const workspaceRoot = root;
    const generation = ++previewGeneration.current;
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      const request = window.brainrouter.previewWorkspaceOnboarding?.(
        workspaceRoot,
        { ...draft },
      );
      if (!request) {
        setPreviewing(false);
        setPlanPreview(null);
        setError('The plan and catalog preview is unavailable. Review the setup again before saving.');
        return;
      }
      void request.then((raw) => {
        if (generation !== previewGeneration.current || root !== workspaceRoot) return;
        const result = raw && typeof raw === 'object' && 'preview' in raw
          ? parseOnboardingPreview((raw as { preview?: unknown }).preview)
          : null;
        setPreviewing(false);
        if (result) setPlanPreview(result);
        else {
          setPlanPreview(null);
          setError('The plan and catalog preview is unavailable. Review the setup again before saving.');
        }
      }).catch(() => {
        if (generation !== previewGeneration.current || root !== workspaceRoot) return;
        setPreviewing(false);
        setPlanPreview(null);
        setError('The plan and catalog preview is unavailable. Review the setup again before saving.');
      });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      previewGeneration.current += 1;
    };
  }, [draft, editor, root]);

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
  const selectedProfile = editor?.profiles.find((profile) => profile.id === draft?.profile);
  const includedPackIds = selectedProfile?.skills.packs ?? [];
  const includedPackLabels = includedPackIds.map((packId) =>
    planPreview?.catalog.find((row) => row.kind === 'skill-pack' && row.id === packId)?.label ?? packId);

  const chooseProfile = (profile: OnboardingProfile): void => {
    const replacement = draftFromOnboardingProfile(profile);
    if (!replacement) return;
    setDraft(replacement);
    setPlanPreview(null);
    setSaveSource('wizard');
    setInstructionDraft(null);
    setInstructionPreview(null);
    setInstructionDecision(null);
    setNotice('Preset applied. Review and edit every field before saving.');
    setError('');
  };

  const propose = (): void => {
    if (!root || !editor || proposing || saving || reviewingInstruction) return;
    if (descriptionProblem) {
      setError(descriptionProblem);
      return;
    }
    const workspaceRoot = root;
    const generation = ++requestGeneration.current;
    setProposing(true);
    setInstructionDraft(null);
    setInstructionPreview(null);
    setInstructionDecision(null);
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
      setPlanPreview(null);
      setSaveSource(proposal.source);
      setInstructionDraft(proposal.instruction);
      setInstructionPreview(null);
      setInstructionDecision(proposal.instruction ? 'pending' : null);
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

  const reviewInstruction = (): void => {
    if (!root || !editor || !instructionDraft || proposing || saving || reviewingInstruction) return;
    const workspaceRoot = root;
    const generation = ++requestGeneration.current;
    setReviewingInstruction(true);
    setInstructionPreview(null);
    setInstructionDecision('pending');
    setError('');
    setNotice('Loading the exact current and proposed AGENT.md text…');
    void bridgeQuery<unknown>(
      'workspace-onboarding-preview-instruction',
      { expected: editor.revision, instruction: instructionDraft },
      15_000,
      workspaceRoot,
    ).then((raw) => {
      if (generation !== requestGeneration.current || root !== workspaceRoot) return;
      const result = parseOnboardingInstructionPreview(raw);
      if (!result) {
        setReviewingInstruction(false);
        setNotice('');
        setError('The instruction preview was incomplete. Review it again before saving.');
        return;
      }
      if (!result.ok) {
        if (result.stale) {
          load(workspaceRoot, `${result.error} The latest setup has been reloaded.`);
          return;
        }
        setReviewingInstruction(false);
        setNotice('');
        setError(result.error);
        return;
      }
      setInstructionPreview(result);
      setReviewingInstruction(false);
      setNotice('Exact AGENT.md text loaded. Choose whether to include it before saving.');
    }).catch(() => {
      if (generation !== requestGeneration.current || root !== workspaceRoot) return;
      setReviewingInstruction(false);
      setNotice('');
      setError('Could not load the exact instruction diff. Review it again before saving.');
    });
  };

  const save = (): void => {
    if (!root || !draft || !editor || !planPreview || previewing ||
        saving || proposing || reviewingInstruction || instructionDecision === 'pending') return;
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError('');
    setNotice('Saving the reviewed workspace setup…');
    const payload = onboardingSavePayload({
      draft,
      revision: editor.revision,
      source: saveSource,
      catalogFingerprint: planPreview.catalogFingerprint,
      instruction: instructionDraft,
      includeInstruction: instructionDecision === 'include',
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
        load(
          root,
          String(result.error
            ?? 'The workspace changed while this dialog was open. The latest setup has been reloaded.'),
        );
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
      if (event.target === event.currentTarget && !saving && !proposing && !reviewingInstruction) onClose();
    }}>
      <div ref={dialogRef} className="dialog onboard-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId}
        aria-busy={loading || saving || proposing || reviewingInstruction}>
        <div className="dialog-title" id={titleId}>{editing ? 'Workspace settings' : `Set up ${workspaceName}`}</div>
        <div className="set-desc" id={descriptionId}>
          Choose a preset, then review every field before saving. Frontend and backend stay engineer capabilities
          and activate only for relevant tasks. Nothing is written until you finish setup.
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
                <button type="button" className="approve"
                  disabled={proposing || saving || reviewingInstruction || Boolean(descriptionProblem)}
                  onClick={propose}>
                  {proposing ? 'Preparing…' : 'Set up with AI'}
                </button>
              </div>
              <label className="onboard-assist-input">
                  <span>What are you building, and how should the primary agent and delegated roles help?</span>
                <textarea value={description} disabled={proposing || saving || reviewingInstruction}
                  maxLength={ONBOARDING_DESCRIPTION_MAX_BYTES}
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
                    disabled={proposing || saving || reviewingInstruction}
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
              <div className="onboard-included-setup" aria-label="Included profile setup">
                <strong>Included profile setup</strong>
                <span>Persona: {selectedProfile?.persona.default || 'None'}</span>
                <span>Skill pack: {includedPackLabels.join(', ') || 'None'}</span>
                <small>These belong to the selected profile. Optional capabilities add narrower task expertise.</small>
              </div>
            </section>

            <section className="onboard-section onboard-fields" aria-labelledby={`${titleId}-details`}>
              <h3 id={`${titleId}-details`}>Persona, orchestration, capabilities, skills, and tools</h3>
              <CatalogChoiceField label="Default domain persona" value={draft.persona.default}
                kind="persona" preview={planPreview} allowEmpty={draft.profile === 'custom'}
                disabled={proposing || saving || reviewingInstruction || previewing}
                emptyLabel="No domain personas are available from the current workspace and enabled plugins."
                onChange={(value) => patchDraft({
                  persona: {
                    default: value,
                    enabled: value && !draft.persona.enabled.includes(value)
                      ? [value, ...draft.persona.enabled]
                      : draft.persona.enabled,
                  },
                })} />
              <CatalogField label="Enabled personas" values={draft.persona.enabled}
                kinds={['persona']} preview={planPreview}
                disabled={proposing || saving || reviewingInstruction || previewing}
                emptyLabel="No domain personas are available from the current workspace and enabled plugins."
                onChange={(enabled) => patchDraft({
                  persona: {
                    default: draft.persona.default && enabled.includes(draft.persona.default)
                      ? draft.persona.default
                      : (enabled[0] ?? ''),
                    enabled,
                  },
                })} />
              <ChoiceField label="Orchestration mode" value={draft.orchestration.mode}
                disabled={proposing || saving || reviewingInstruction}
                hint="Available roles are a ceiling. Off keeps work with the primary agent."
                onChange={(mode) => patchDraft({
                  orchestration: { ...draft.orchestration, mode },
                })} />
              <NumberField label="Maximum parallel roles" value={draft.orchestration.maxParallel}
                disabled={proposing || saving || reviewingInstruction}
                onChange={(maxParallel) => patchDraft({
                  orchestration: { ...draft.orchestration, maxParallel },
                })} />
              <CatalogField label="Available orchestration roles" values={draft.orchestration.availableRoles}
                kinds={['role']} preview={planPreview}
                disabled={proposing || saving || reviewingInstruction || previewing}
                onChange={(availableRoles) => patchDraft({
                  orchestration: { ...draft.orchestration, availableRoles },
                })} />
              <CatalogField label="Disabled orchestration roles" values={draft.orchestration.disabledRoles}
                kinds={['role']} preview={planPreview} allowBlocked
                showRecommendedAdditions={false}
                disabled={proposing || saving || reviewingInstruction || previewing}
                onChange={(disabledRoles) => patchDraft({
                  orchestration: {
                    ...draft.orchestration,
                    availableRoles: draft.orchestration.availableRoles
                      .filter((role) => !disabledRoles.includes(role)),
                    disabledRoles,
                  },
                })} />
              <CatalogField label="Optional capabilities" values={draft.capabilities.enabled}
                kinds={['capability']} preview={planPreview} hideUnavailable
                emptyLabel="No optional capabilities are contributed for this profile."
                disabled={proposing || saving || reviewingInstruction || previewing}
                onChange={(enabled) => patchDraft({
                  capabilities: {
                    enabled,
                    disabled: draft.capabilities.disabled
                      .filter((capability) => !enabled.includes(capability)),
                  },
                })} />
              <CatalogField label="Disabled optional capabilities" values={draft.capabilities.disabled}
                kinds={['capability']} preview={planPreview} allowBlocked hideUnavailable
                showRecommendedAdditions={false}
                emptyLabel="No optional capabilities are contributed for this profile."
                disabled={proposing || saving || reviewingInstruction || previewing}
                onChange={(disabled) => patchDraft({
                  capabilities: {
                    enabled: draft.capabilities.enabled
                      .filter((capability) => !disabled.includes(capability)),
                    disabled,
                  },
                })} />
              <CatalogField label="Tool groups" values={draft.tools.profiles}
                kinds={['tool-group']} preview={planPreview}
                disabled={proposing || saving || reviewingInstruction || previewing}
                onChange={(values) => patchDraft({ tools: { ...draft.tools, profiles: values } })} />
              <details className="onboard-advanced">
                <summary>
                  <span>Advanced skills and tools</span>
                  <span>Optional fine-grained overrides</span>
                </summary>
                <div className="onboard-advanced-grid">
                  <CatalogField label="Additional skill packs"
                    values={draft.skills.packs.filter((packId) => !includedPackIds.includes(packId))}
                    kinds={['skill-pack']} preview={planPreview} excludedIds={includedPackIds}
                    disabled={proposing || saving || reviewingInstruction || previewing}
                    onChange={(values) => patchDraft({
                      skills: { ...draft.skills, packs: [...includedPackIds, ...values] },
                    })} />
                  <CatalogField label="Enabled individual skills" values={draft.skills.enabled}
                    kinds={['skill']} preview={planPreview}
                    disabled={proposing || saving || reviewingInstruction || previewing}
                    onChange={(values) => patchDraft({ skills: { ...draft.skills, enabled: values } })} />
                  <CatalogField label="Disabled skills" values={draft.skills.disabled}
                    kinds={['skill']} preview={planPreview} allowBlocked
                    showRecommendedAdditions={false}
                    disabled={proposing || saving || reviewingInstruction || previewing}
                    onChange={(values) => patchDraft({ skills: { ...draft.skills, disabled: values } })} />
                  <CatalogField label="Additional individual tools" values={draft.tools.enabled}
                    kinds={['tool']} preview={planPreview}
                    disabled={proposing || saving || reviewingInstruction || previewing}
                    onChange={(values) => patchDraft({ tools: { ...draft.tools, enabled: values } })} />
                  <CatalogField label="Denied tool groups or tools" values={draft.tools.deny}
                    kinds={['tool-group', 'tool']} preview={planPreview} allowBlocked
                    showRecommendedAdditions={false}
                    disabled={proposing || saving || reviewingInstruction || previewing}
                    onChange={(values) => patchDraft({ tools: { ...draft.tools, deny: values } })} />
                </div>
              </details>
              <ListField label="Memory tags" values={draft.memory.tags}
                disabled={proposing || saving || reviewingInstruction}
                onChange={(values) => patchDraft({ memory: { ...draft.memory, tags: values } })} />
              <TextField label="Memory capture hint" value={draft.memory.captureHint}
                disabled={proposing || saving || reviewingInstruction}
                onChange={(value) => patchDraft({ memory: { ...draft.memory, captureHint: value } })} />
              <TextField label="Instruction file" value={draft.instructions}
                disabled={proposing || saving || reviewingInstruction}
                hint="Project-relative pointer; generated instruction proposals are limited to AGENT.md."
                onChange={(value) => {
                  patchDraft({ instructions: value });
                  if (value !== 'AGENT.md') {
                    setInstructionDraft(null);
                    setInstructionPreview(null);
                    setInstructionDecision(null);
                  }
                }} />
            </section>

            <PlanPreviewCard preview={planPreview} loading={previewing} />

            <section className="onboard-section" aria-labelledby={`${titleId}-review`}>
              <h3 id={`${titleId}-review`}>Review file changes</h3>
              <div className="onboard-diff-label">
                <span>{editing ? 'Update' : 'Create'} .brainrouter/workspace.json</span>
                <span>{preview.length} characters</span>
              </div>
              <pre className="onboard-diff">{preview}</pre>
              {instructionDraft ? (
                <div className="onboard-instruction-review">
                  <div className="onboard-instruction-heading">
                    <div>
                      <strong>Optional AGENT.md change</strong>
                      <span>Review the exact current and proposed text, then explicitly include or reject it.</span>
                    </div>
                    <button type="button" className="deny" disabled={saving || proposing || reviewingInstruction}
                      onClick={reviewInstruction}>
                      {reviewingInstruction ? 'Loading exact diff…' : instructionPreview ? 'Refresh exact diff' : 'Review exact diff'}
                    </button>
                  </div>
                  {instructionPreview ? (
                    <>
                      <div className="onboard-instruction-grid">
                        <div>
                          <div className="onboard-diff-label">
                            <span>{instructionPreview.existed ? 'Current AGENT.md' : 'Current AGENT.md (new file)'}</span>
                            <span>{instructionPreview.originalBytes} bytes</span>
                          </div>
                          <pre className="onboard-diff">{instructionPreview.original}</pre>
                        </div>
                        <div>
                          <div className="onboard-diff-label">
                            <span>Proposed AGENT.md</span>
                            <span>{instructionPreview.proposedBytes} bytes</span>
                          </div>
                          <pre className="onboard-diff">{instructionPreview.proposed}</pre>
                        </div>
                      </div>
                      <div className="onboard-instruction-actions" role="group" aria-label="AGENT.md decision">
                        <button type="button" className={instructionDecision === 'exclude' ? 'selected' : ''}
                          aria-pressed={instructionDecision === 'exclude'} disabled={saving || proposing || reviewingInstruction}
                          onClick={() => { setInstructionDecision('exclude'); setNotice('AGENT.md will remain unchanged.'); }}>
                          Keep unchanged
                        </button>
                        <button type="button" className={instructionDecision === 'include' ? 'selected' : ''}
                          aria-pressed={instructionDecision === 'include'} disabled={saving || proposing || reviewingInstruction}
                          onClick={() => { setInstructionDecision('include'); setNotice('The reviewed AGENT.md change will be included.'); }}>
                          Include reviewed change
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="onboard-no-instruction">The instruction change is excluded until exact review and a decision.</div>
                  )}
                </div>
              ) : <div className="onboard-no-instruction">No instruction-file change is included.</div>}
            </section>
          </div>
        )}

        <div className="onboard-status" aria-live="polite" aria-atomic="true">
          {error ? <span className="onboard-error">{error}</span> : notice ? <span>{notice}</span> : null}
        </div>
        <div className="dialog-actions">
          <button type="button" className="deny" disabled={saving || proposing || reviewingInstruction} onClick={onClose}>
            {editing ? 'Cancel' : 'Skip setup for now'}
          </button>
          <button type="button" className="approve"
            disabled={!draft || !editor || !planPreview || loading || previewing ||
              saving || proposing || reviewingInstruction || instructionDecision === 'pending'}
            onClick={save}>
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

function ChoiceField({ label, value, hint, disabled = false, onChange }: {
  label: string;
  value: 'off' | 'explicit' | 'adaptive';
  hint?: string;
  disabled?: boolean;
  onChange: (value: 'off' | 'explicit' | 'adaptive') => void;
}): React.ReactElement {
  return (
    <div className="onboard-field">
      <span>{label}</span>
      <div className="onboard-choice" role="group" aria-label={label}>
        {(['off', 'explicit', 'adaptive'] as const).map((mode) => (
          <button type="button" key={mode} disabled={disabled}
            className={value === mode ? 'selected' : ''}
            aria-pressed={value === mode}
            onClick={() => onChange(mode)}>
            {mode[0].toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function NumberField({ label, value, disabled = false, onChange }: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}): React.ReactElement {
  return (
    <label className="onboard-field">
      <span>{label}</span>
      <input type="number" min={1} max={32} step={1} value={value} disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= 1 && next <= 32) onChange(next);
        }} />
      <small>Between 1 and 32 concurrent delegated roles.</small>
    </label>
  );
}
