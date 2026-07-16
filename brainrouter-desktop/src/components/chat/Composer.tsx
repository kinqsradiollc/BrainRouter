/**
 * T4 — the chat composer (input + slash popup + the controls row: mode, folder,
 * branch, effort, model, context ring). Extracted verbatim from App.tsx; the App
 * owns all state and passes it through (the popovers/menus are inline as before).
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../../icons.js';
import { ProviderIcon } from '../model/ProviderIcon.js';
import { ModelIcon } from '../model/ModelIcon.js';
import { ReasoningSlider } from '../model/ReasoningSlider.js';
import { SlashPopup } from '../../palette.js';
import { UsageBar } from '../status/UsageBar.js';
import { ContextRing } from '../status/ContextRing.js';
import { NON_CHAT_MODEL } from '../../constants.js';
import { modelCapabilities, capabilityBadges } from '../../lib/models/modelCapabilities.js';
import { reasoningProfileForModel, reasoningPillLabel } from '../../lib/models/reasoningProfile.js';
import type { AttachmentUpload, PopId } from '../../types.js';
import type { DeskCommand, SettingsSection } from '../../lib/commands/commands.js';
import { recognizedCommandToken } from '../../lib/composer/slashHighlight.js';
import { findMentionToken, rankFileMatches, applyMention } from '../../lib/composer/mention.js';
import { hostQuery } from '../../lib/hostQuery.js';
import { usePlatform } from '../../lib/shortcuts/shortcuts.js';
import type { ConfigSnapshot } from '../../settings.js';
import { symbolKindIcon } from '../../lib/browser/rowSource.js';

export interface ComposerProps {
  draft: string;
  setDraft: (v: string) => void;
  running: boolean;
  stopping: boolean;
  submit: () => void;
  requestStop: () => void;
  slashActive: boolean;
  slashMatches: DeskCommand[];
  commands: DeskCommand[];
  slashSel: number;
  setSlashSel: Dispatch<SetStateAction<number>>;
  setSlashDismissed: (v: boolean) => void;
  onRunSlash: (c: DeskCommand) => void;
  pop: PopId;
  setPop: Dispatch<SetStateAction<PopId>>;
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  modeLabel: string;
  effort: string;
  info: { workspaceRoot?: string; model?: string; provider?: string };
  branches: { current: string | null; branches: string[]; loading?: boolean };
  endpointModels: string[];
  // §multi-select-models — the default provider's allowlist. When non-empty the
  // model menu lists only these (∩ the live endpoint list); empty ⇒ full list.
  allowedModels?: string[];
  // §connected-models — every saved provider (name + its allowlist/default), so
  // the model menu can list and switch to any connected provider, not just the
  // active endpoint. defaultProviderName marks which one is currently active.
  connectedProviders?: Array<{ name: string; provider: string; model: string; models?: string[]; endpoint?: string | null }>;
  accountModels?: ConfigSnapshot['accountModels'];
  defaultProviderName?: string | null;
  routerCatalog?: ConfigSnapshot['routerCatalog'];
  routerFallback?: string | null;
  modelsLoading: boolean;
  setModelsLoading: (v: boolean) => void;
  modelChoices: string[];
  modelScope: 'global' | 'session';
  setModelScope: Dispatch<SetStateAction<'global' | 'session'>>;
  hasConversation: boolean;
  contextUsage: { used: number; window: number; compactAt: number; limit: number; pct: number } | null;
  tokens: { promptTokens: number; completionTokens: number; turns: number } | null;
  openSettings: (section: SettingsSection) => void;
  /** §5 — attach files (picker or drag/drop) to the session. */
  onAttach?: (files: File[]) => void;
  attachments?: AttachmentUpload[];
  onClearAttachment?: (id: string) => void;
  canSubmit?: boolean;
  /** vision — pasted screenshots, sent inline to a vision-capable model. */
  pastedImages?: Array<{ id: string; mediaType: string; dataBase64: string }>;
  onPasteImages?: (files: File[]) => void;
  onClearPastedImage?: (id: string) => void;
  /** §a11y-inspect — component reference tags dragged from the Browser panel. */
  componentTags?: Array<{ id: string; name: string; kind?: string; ref: string; steps?: Array<{ action: string; target: string; text?: string }> }>;
  onDropTag?: (tag: { name: string; kind?: string; ref: string; filePath?: string; line?: number; steps?: Array<{ action: string; target: string; text?: string }> }) => void;
  onClearComponentTag?: (id: string) => void;
  /** Allows shell-level start actions to focus the message input without DOM queries. */
  inputRef?: React.RefObject<HTMLTextAreaElement>;
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const CHANGE_POLICIES = [
  {
    modeLabel: 'Plan mode',
    label: 'Plan first',
    detail: 'Review the plan and approve routine actions as work proceeds.',
    executionMode: 'planning',
    reviewPolicy: 'request',
    shortcut: '1',
  },
  {
    modeLabel: 'Accept edits',
    label: 'Change directly',
    detail: 'Apply edits and routine commands while keeping plan review.',
    executionMode: 'fast',
    reviewPolicy: 'request',
    shortcut: '2',
  },
  {
    modeLabel: 'Auto mode',
    label: 'Continue automatically',
    detail: 'Skip plan review and handle routine actions automatically.',
    executionMode: 'fast',
    reviewPolicy: 'proceed',
    shortcut: '3',
  },
] as const;

export function Composer(p: ComposerProps): React.ReactElement {
  const {
    draft, setDraft, running, stopping, submit, requestStop, slashActive, slashMatches, commands,
    slashSel, setSlashSel, setSlashDismissed, onRunSlash, pop, setPop, q, modeLabel, effort,
    info, branches, endpointModels, allowedModels, connectedProviders, accountModels, defaultProviderName, routerCatalog, routerFallback, modelsLoading, setModelsLoading, modelChoices, modelScope, setModelScope,
    hasConversation, contextUsage, tokens, openSettings, onAttach, attachments = [], onClearAttachment, canSubmit = false,
    pastedImages = [], onPasteImages, onClearPastedImage,
    componentTags = [], onDropTag, onClearComponentTag, inputRef,
  } = p;
  const { fmt } = usePlatform(); // §shortcuts — OS-correct menu hint glyphs
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const internalTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = inputRef ?? internalTextareaRef;
  const mirrorRef = React.useRef<HTMLDivElement | null>(null);
  const modelMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  // §5.7 — @-mention: workspace file picker. Self-contained (independent of the
  // slash system); fetched once, recomputed from the caret on each keystroke.
  const [mentionFiles, setMentionFiles] = React.useState<string[]>([]);
  const [mention, setMention] = React.useState<{ token: ReturnType<typeof findMentionToken>; matches: string[] } | null>(null);
  const [mentionSel, setMentionSel] = React.useState(0);
  const modelRecentsKey = `br-model-recents:${info.workspaceRoot ?? 'global'}`;
  const [modelRecents, setModelRecents] = React.useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(modelRecentsKey) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 5) : [];
    } catch {
      return [];
    }
  });
  React.useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(modelRecentsKey) ?? '[]');
      setModelRecents(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 5) : []);
    } catch {
      setModelRecents([]);
    }
  }, [modelRecentsKey]);
  const rememberModel = React.useCallback((model: string): void => {
    if (!model || model === 'auto') return;
    setModelRecents((cur) => {
      const next = [model, ...cur.filter((item) => item !== model)].slice(0, 5);
      try { localStorage.setItem(modelRecentsKey, JSON.stringify(next)); } catch { /* localStorage may be unavailable in tests */ }
      return next;
    });
  }, [modelRecentsKey]);
  React.useEffect(() => {
    void hostQuery<{ files?: Array<string | { path?: string }> }>('list-files', { limit: 3000 }).then((r) => {
      setMentionFiles((r?.files ?? []).map((f) => (typeof f === 'string' ? f : f.path ?? '')).filter(Boolean));
    });
  }, []);
  const recomputeMention = React.useCallback((value: string, caret: number) => {
    const token = findMentionToken(value, caret);
    if (!token) { setMention(null); return; }
    const matches = rankFileMatches(token.query, mentionFiles, 8);
    setMention(matches.length ? { token, matches } : null);
    setMentionSel(0);
  }, [mentionFiles]);
  const pickMention = React.useCallback((path: string) => {
    setMention((m) => {
      if (!m?.token) return null;
      const ta = textareaRef.current;
      const caret = ta ? ta.selectionStart : draft.length;
      const out = applyMention(draft, m.token, caret, path);
      setDraft(out.text);
      requestAnimationFrame(() => { const t = textareaRef.current; if (t) { t.focus(); t.setSelectionRange(out.caret, out.caret); } });
      return null;
    });
  }, [draft, setDraft]);
  const mentionOpen = !!(mention && mention.matches.length && !(slashActive && slashMatches.length));
  // The model menu opens UPWARD from the composer. A tall menu (several connected
  // providers) could push its top — the "Models" header + first model — above the
  // viewport, clipping them. Clamp its height to the room actually above the
  // trigger so it never overflows the top; it scrolls internally instead.
  React.useLayoutEffect(() => {
    if (pop !== 'model') return;
    const el = modelMenuRef.current;
    if (!el) return;
    const bottom = el.getBoundingClientRect().bottom; // bottom-anchored: stable vs height
    el.style.maxHeight = `${Math.max(220, Math.min(440, Math.floor(bottom - 14)))}px`;
  }, [pop]);
  const handleFiles = (list: FileList | null): void => {
    if (!list || !onAttach) return;
    const files = Array.from(list);
    if (files.length) onAttach(files);
  };
  const pickModelRequest = (model: string, providerName?: string, managed = false): void => {
    window.brainrouter.send({ kind: 'set-model', model, ...(providerName ? { providerName } : {}), persist: managed ? false : modelScope === 'global' });
    rememberModel(providerName ? `${providerName}/${model}` : model);
    setPop('');
  };
  const syncMirrorScroll = React.useCallback(() => {
    if (textareaRef.current && mirrorRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const styles = window.getComputedStyle(el);
    const maxHeight = Number.parseFloat(styles.maxHeight) || 180;
    const minHeight = Number.parseFloat(styles.minHeight) || 34;
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
    syncMirrorScroll();
  }, [draft, attachments.length, syncMirrorScroll]);
  // §slash-highlight — when the draft is a recognized command, the textarea text
  // goes transparent and this mirror paints it instead, with the "/command"
  // token in accent blue so the user sees they're in that command's mode.
  const cmdToken = recognizedCommandToken(draft, slashActive, slashMatches, commands);
  // reasoning-profiles — the effort control is MODEL-FAMILY aware (graded tiers /
  // binary On-Off / locked "Always on" / hidden). Reasoning is DECOUPLED from
  // Fast mode: this slider is the user's explicit choice and stays live; Fast
  // mode (a Settings toggle) only changes the agentic strategy, not the thinking.
  const activeManagedPolicy = info.provider === 'brainrouter'
    ? accountModels?.models.find((model) => model.id === info.model) ?? null
    : null;
  const managedSelectionInvalid = info.provider === 'brainrouter' && !activeManagedPolicy;
  const reasoningProfile = reasoningProfileForModel(info.model, activeManagedPolicy);
  const reasoningPill = reasoningPillLabel(reasoningProfile, effort, false);
  const managedEffortInvalid = !!activeManagedPolicy?.reasoning
    && !activeManagedPolicy.reasoning.allowed.some((option) => option.id === effort);
  const selectedChangePolicy = CHANGE_POLICIES.find((policy) => policy.modeLabel === modeLabel) ?? CHANGE_POLICIES[0];
  return (
    <div className="composer">
      <div
        className={`box${dragOver ? ' drag-over' : ''}`}
        onDragOver={onAttach || onDropTag ? (e) => { e.preventDefault(); if (!dragOver) setDragOver(true); } : undefined}
        onDragLeave={onAttach || onDropTag ? () => setDragOver(false) : undefined}
        onDrop={onAttach || onDropTag ? (e) => {
          e.preventDefault(); setDragOver(false);
          if (e.dataTransfer.files.length) { handleFiles(e.dataTransfer.files); return; }
          // §a11y-inspect — a dragged Accessibility row becomes a component tag chip;
          // any other dragged text falls back to appending its reference to the draft.
          const tagJson = e.dataTransfer.getData('application/x-brainrouter-tag');
          if (tagJson && onDropTag) {
            try { onDropTag(JSON.parse(tagJson)); return; } catch { /* fall through to text */ }
          }
          const ref = e.dataTransfer.getData('application/x-brainrouter-ref') || e.dataTransfer.getData('text/plain');
          if (ref) setDraft(draft ? draft.replace(/\s*$/, '') + ' ' + ref : ref);
        } : undefined}
      >
        {slashActive && slashMatches.length ? (
          <div className="slash-pop">
            <SlashPopup commands={commands} filter={draft} selected={slashSel} onPick={onRunSlash} onHover={setSlashSel} />
          </div>
        ) : null}
        {mentionOpen ? (
          <div className="mention-pop" role="listbox" aria-label="Workspace files">
            {mention!.matches.map((f, i) => (
              <button
                key={f}
                type="button"
                role="option"
                aria-selected={i === mentionSel}
                className={`mention-item${i === mentionSel ? ' sel' : ''}`}
                onMouseEnter={() => setMentionSel(i)}
                onMouseDown={(e) => { e.preventDefault(); pickMention(f); }}
              >
                <Icon name="file" size={12} />
                <span className="mention-base">{f.slice(f.lastIndexOf('/') + 1)}</span>
                <span className="mention-path">{f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}</span>
              </button>
            ))}
          </div>
        ) : null}
        {attachments.length ? (
          <div className="attachment-strip" aria-label="Attached files">
            {attachments.map((file) => (
              <div key={file.id} className={`attachment-chip ${file.status}`} title={`${file.name} · ${formatBytes(file.size)}${file.detail ? ` · ${file.detail}` : ''}`}>
                <Icon name="file" size={13} />
                <span className="attachment-name">{file.name}</span>
                <span className="attachment-meta">{file.status === 'attached' ? 'ready' : file.status === 'failed' ? 'needs retry' : file.status}</span>
                <span className="attachment-size">{formatBytes(file.size)}</span>
                {onClearAttachment && (file.status === 'attached' || file.status === 'failed') ? (
                  <button type="button" className="attachment-clear" aria-label={`Remove ${file.name}`} onClick={() => onClearAttachment(file.id)}>
                    <Icon name="close" size={11} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {pastedImages.length ? (
          <div className="attachment-strip" aria-label="Pasted images">
            {pastedImages.map((img) => (
              <div key={img.id} className="image-chip" title="Pasted image">
                <img src={`data:${img.mediaType};base64,${img.dataBase64}`} alt="Pasted screenshot" />
                {onClearPastedImage ? (
                  <button type="button" className="attachment-clear" aria-label="Remove image" onClick={() => onClearPastedImage(img.id)}>
                    <Icon name="close" size={11} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {componentTags.length ? (
          <div className="attachment-strip" aria-label="Tagged components">
            {componentTags.map((t) => (
              <div key={t.id} className="tag-chip" title={t.ref}>
                <Icon name={symbolKindIcon(t.kind)} size={13} />
                <span className="attachment-name">{t.name}</span>
                {t.kind ? <span className="attachment-meta">{t.kind}</span> : null}
                {onClearComponentTag ? (
                  <button type="button" className="attachment-clear" aria-label={`Remove ${t.name}`} onClick={() => onClearComponentTag(t.id)}>
                    <Icon name="close" size={11} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {pastedImages.length && info.model && !modelCapabilities(info.model).vision ? (
          <div className="vision-warn" role="status">
            <Icon name="eye" size={12} /> <span>{info.model} may not read images — switch to a vision model.</span>
          </div>
        ) : null}
        <div className="input-wrap">
          {cmdToken ? (
            <div ref={mirrorRef} className="input-mirror" aria-hidden="true">
              <span className="cmd-token">{cmdToken}</span>{draft.slice(cmdToken.length)}{'​'}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className={cmdToken ? 'cmd-mode' : undefined}
            rows={1}
            placeholder={stopping ? 'Stopping…' : running ? 'Working…' : 'Message BrainRouter…  ( / for commands )'}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setSlashSel(0); setSlashDismissed(false); recomputeMention(e.target.value, e.target.selectionStart); }}
            onScroll={syncMirrorScroll}
            onPaste={onPasteImages ? (e) => {
              // §vision — pull any image blobs off the clipboard (a pasted
              // screenshot) and hand them up; let text paste through untouched.
              const files = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length) { e.preventDefault(); onPasteImages(files); }
            } : undefined}
            onKeyDown={(e) => {
              // §5.7 — @-mention picker keys (gated; never competes with slash).
              if (mentionOpen && mention) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSel((s) => Math.min(s + 1, mention.matches.length - 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSel((s) => Math.max(s - 1, 0)); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mention.matches[Math.min(mentionSel, mention.matches.length - 1)]); return; }
                if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
              }
              if (slashActive && slashMatches.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((s) => Math.min(s + 1, slashMatches.length - 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((s) => Math.max(s - 1, 0)); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); onRunSlash(slashMatches[Math.min(slashSel, slashMatches.length - 1)]); return; }
                if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              if (e.key === 'Escape' && running) requestStop();
            }}
          />
        </div>
        {onAttach ? (
          <>
            <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
            <button type="button" className="input-attach icon-btn" title="Attach a file (PDF, image, text, code)"
              aria-label="Attach a file" onClick={() => fileInputRef.current?.click()}>
              <Icon name="file" size={14} />
            </button>
          </>
        ) : null}
        <button className={`input-send icon-btn${running ? ' stop-red' : ''}${stopping ? ' stopping' : ''}`} title={stopping ? 'Stopping…' : running ? 'Stop' : 'Send'}
          onClick={() => running ? requestStop() : submit()}
          disabled={(!running && !draft.trim() && !canSubmit && pastedImages.length === 0) || stopping}>{running ? <Icon name="stop" size={14} /> : <Icon name="arrow-up" size={14} />}</button>
        <div className="composer-controls">
          <span className="pop-wrap composer-policy">
            {pop === 'mode' ? (
              <div className="menu-pop left change-policy-menu">
                <div className="menu-head"><span>Change policy</span><span>{fmt('Mod+Shift+M')}</span></div>
                {CHANGE_POLICIES.map((policy) => (
                  <button key={policy.modeLabel} className="menu-item" onClick={() => {
                    q('a-mode', 'action:set-session-mode', { executionMode: policy.executionMode, reviewPolicy: policy.reviewPolicy });
                    setPop('');
                  }}>
                    <span className="mi-check">{modeLabel === policy.modeLabel ? '✓' : ''}</span>
                    <span className="change-policy-copy">{policy.label}<span className="choice-detail">{policy.detail}</span></span>
                    <span className="mi-hint">{policy.shortcut}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" className="chip dim" title={`Change policy: ${selectedChangePolicy.label}`} aria-label={`Change policy: ${selectedChangePolicy.label}`} onClick={() => setPop(pop === 'mode' ? '' : 'mode')}>
              {selectedChangePolicy.label}<Icon name="chev-down" size={9} />
            </button>
          </span>
          <button type="button" className="ctx-chip composer-workspace" title={info.workspaceRoot}>
            <Icon name="folder" size={11} />
            <span>{info.workspaceRoot?.split('/').pop() ?? 'workspace'}</span>
          </button>
          <span className="pop-wrap composer-branch">
            {pop === 'branch' ? (
              <div className="menu-pop left" style={{ bottom: 'calc(100% + 8px)' }}>
                <div className="menu-head"><span>Branches</span></div>
                {branches.branches.slice(0, 12).map((b) => (
                  <button key={b} className="menu-item" onClick={() => {
                    setPop('');
                    if (b === branches.current) return;
                    q('a-term', 'action:term-exec', { cmd: `git checkout ${JSON.stringify(b).slice(1, -1)}` });
                    setTimeout(() => { q('q-branches', 'git-branches'); q('q-git', 'git-info'); }, 600);
                  }}>
                    <span className="mi-check">{b === branches.current ? '✓' : ''}</span>{b}
                  </button>
                ))}
                {branches.branches.length === 0 ? <div className="empty">Not a git repository.</div> : null}
              </div>
            ) : null}
            {branches.current ? (
              <button type="button" className="ctx-chip" onClick={() => setPop(pop === 'branch' ? '' : 'branch')}>
                <Icon name="branch" size={11} />
                <span>{branches.current}</span>
                <Icon name="chev-down" size={9} />
              </button>
            ) : branches.loading ? (
              <span className="ctx-chip" style={{ opacity: 0.6 }}>
                <Icon name="branch" size={11} /><span>loading…</span>
              </span>
            ) : null}
          </span>
          <span className="composer-spacer" />
          {/* DESK-5q + reasoning-profiles — the effort control adapts to the
              SELECTED model's family: graded tiers, binary On/Off, a locked
              "Always on", or nothing for non-reasoning models. Always live
              (decoupled from Fast mode); only an always-on reasoner locks it. */}
          <span className="model-effort-control">
          {reasoningPill ? (
            <span className="pop-wrap composer-effort">
              {pop === 'effort' && reasoningProfile.options.length ? (
                <div className="menu-pop effort-menu">
                  <div className="menu-head"><span>Reasoning effort</span><span>{reasoningProfile.source === 'server' ? 'Managed policy' : 'Inferred'}</span></div>
                  <ReasoningSlider
                    profile={reasoningProfile}
                    effort={effort}
                    onPick={(lvl) => q('a-mode', 'action:set-session-mode', { effort: lvl })}
                  />
                </div>
              ) : null}
              <button
                type="button"
                className={`effort-pill${managedEffortInvalid ? ' invalid' : ''}`}
                aria-label={`Reasoning effort: ${reasoningPill}`}
                title={managedEffortInvalid ? 'This effort is unavailable for the managed model. Choose another effort.' : reasoningProfile.kind === 'always-on' ? 'This model always reasons' : 'Reasoning effort'}
                disabled={reasoningProfile.kind === 'always-on'}
                style={reasoningProfile.kind === 'always-on' ? { opacity: 0.6 } : undefined}
                onClick={() => { if (reasoningProfile.options.length) setPop(pop === 'effort' ? '' : 'effort'); }}
              >
                {reasoningPill}
              </button>
            </span>
          ) : null}
          {/* model selection is now separate from effort */}
          <span className="pop-wrap composer-model">
            {pop === 'model' ? (
              <div className="menu-pop model-menu" ref={modelMenuRef}>
                {(() => {
                  const managedMenu = accountModels?.signedIn ? (
                    <>
                      <div className="menu-head"><span>BrainRouter managed</span><span>{accountModels.stale ? 'Last known' : 'Account'}</span></div>
                      <div className="model-list">
                        {accountModels.models.length ? accountModels.models.map((model) => (
                          <button key={`brainrouter:${model.id}`} className="menu-item model-item"
                            title={`Use ${model.label} for this chat`}
                            onClick={() => pickModelRequest(model.id, 'brainrouter-account', true)}>
                            <span className="mi-check">{info.provider === 'brainrouter' && model.id === info.model ? '✓' : ''}</span>
                            <span className="managed-provider-mark managed-provider-mark--menu" aria-hidden="true">BR</span>
                            <span className="model-id">{model.label}<span className="choice-detail">{model.id}</span></span>
                            <span className="model-caps"><span className="cap-chip cap-reasoning" title="Server-managed reasoning policy">{model.reasoning ? `${model.reasoning.allowed.length} efforts` : 'fixed'}</span></span>
                          </button>
                        )) : <div className="empty">{accountModels.error ?? 'No managed models are available.'}</div>}
                      </div>
                    </>
                  ) : null;
                  if (routerCatalog) {
                    const primary = (routerCatalog.primaryChain ?? []).filter(Boolean);
                    // Router-first (always on): the picker offers the routes, not a
                    // per-provider model catalog. Every pick is Auto (the primary
                    // chain), a chain entry, or one of your recent routes — each
                    // resolves through the one proxy. To add or pin a specific
                    // model, edit the chain in Settings → Models → Routing
                    // ("Custom model…" below).
                    const allRequests = new Set([
                      ...primary,
                      ...((routerCatalog.aliases ?? []).map((item) => item.id)),
                      ...((routerCatalog.canonical ?? []).map((item) => item.id)),
                    ]);
                    const recents = modelRecents.filter((item) => allRequests.has(item));
                    const renderRouterItem = (request: string, label: string, detail?: string): React.ReactElement => {
                      const badges = capabilityBadges(modelCapabilities(label));
                      return (
                        <button key={request} className="menu-item model-item" onClick={() => pickModelRequest(request)} title={detail}>
                          <span className="mi-check">{request === info.model ? '✓' : ''}</span>
                          <ModelIcon model={label} style={{ marginRight: 6 }} />
                          <span className="model-id">{label}</span>
                          {detail ? <span className="choice-detail" style={{ marginLeft: 6 }}>{detail}</span> : null}
                          {badges.length ? (
                            <span className="model-caps">
                              {badges.map((b) => <span key={b.key} className={`cap-chip cap-${b.key}`} title={b.title}>{b.label}</span>)}
                            </span>
                          ) : null}
                        </button>
                      );
                    };
                    return (
                      <>
                        {managedMenu}
                        <div className="menu-head"><span>Provider router</span><span>{fmt('Mod+Shift+I')}</span></div>
                        <div className="model-list">
                          <button className="menu-item model-item" onClick={() => {
                            window.brainrouter.send({ kind: 'set-model', model: 'auto', persist: false });
                            setPop('');
                          }}>
                            <span className="mi-check" />
                            <ModelIcon model={info.model ?? 'auto'} style={{ marginRight: 6 }} />
                            <span className="model-id">Auto (primary chain)</span>
                          </button>
                        </div>
                        {recents.length ? (
                          <>
                            <div className="menu-head"><span>Recent</span></div>
                            <div className="model-list">{recents.map((request) => renderRouterItem(request, request))}</div>
                          </>
                        ) : null}
                        {primary.length ? (
                          <>
                            <div className="menu-head"><span>Primary chain</span></div>
                            <div className="model-list">{primary.map((request, index) => renderRouterItem(request, request, index === 0 ? 'Primary' : `Fallback ${index}`))}</div>
                          </>
                        ) : (
                          <div className="menu-head"><span>Chain is empty · base model serves all traffic</span></div>
                        )}
                      </>
                    );
                  }
                  // §multi-select-models — when the default provider saved an
                  // allowlist, narrow the live endpoint list to it (∩); an empty
                  // allowlist falls through to the full list (unchanged behavior).
                  const allow = allowedModels ?? [];
                  const base = allow.length ? endpointModels.filter((m) => allow.includes(m)) : endpointModels;
                  // DESK-5l — only models that can actually chat;
                  // embedding/audio/rerank picks broke the session.
                  const chatModels = base.filter((m) => !NON_CHAT_MODEL.test(m));
                  const hidden = base.length - chatModels.length;
                  const listed = [...new Set([...(chatModels.length ? chatModels : []), ...modelChoices])];
                  // §connected-models — every OTHER saved provider, listing its
                  // models (the saved allowlist, else its single default) so you can
                  // switch provider + model right here, not just the active endpoint.
                  const providerGroups = (connectedProviders ?? [])
                    .filter((p) => p.name !== (defaultProviderName ?? null))
                    .map((p) => ({ name: p.name, provider: p.provider, models: ((p.models && p.models.length) ? p.models : (p.model ? [p.model] : [])).filter((m) => !NON_CHAT_MODEL.test(m)) }))
                    .filter((g) => g.models.length);
                  return (
                    <>
                      {managedMenu}
                      <div className="menu-head"><span>Models{chatModels.length ? ` · ${chatModels.length} on endpoint` : ''}</span><span>{fmt('Mod+Shift+I')}</span></div>
                      <div className="model-list model-list-endpoint">
                        {modelsLoading && !endpointModels.length ? (
                          <div className="empty" style={{ padding: '4px 9px' }}>Loading models…</div>
                        ) : null}
                        {!modelsLoading && !endpointModels.length ? (
                          <div className="empty" style={{ padding: '4px 9px' }}>Endpoint returned no models — check the connection in Settings.</div>
                        ) : null}
                        {listed.map((m, i) => {
                          // §13 — capability hints derived from the model id (heuristic).
                          const badges = capabilityBadges(modelCapabilities(m));
                          return (
                            <button key={m} className="menu-item model-item" onClick={() => {
                              // Item 10 — scope decides where it's saved: global (config.json) or this chat only.
                              pickModelRequest(m);
                            }}>
                              <span className="mi-check">{m === info.model ? '✓' : ''}</span>
                              <ModelIcon model={m} style={{ marginRight: 6 }} />
                              <span className="model-id">{m}</span>
                              {badges.length ? (
                                <span className="model-caps">
                                  {badges.map((b) => <span key={b.key} className={`cap-chip cap-${b.key}`} title={b.title}>{b.label}</span>)}
                                </span>
                              ) : null}
                              <span className="mi-hint">{i < 9 ? i + 1 : ''}</span>
                            </button>
                          );
                        })}
                      </div>
                      {hidden > 0 ? (
                        <div className="menu-head"><span>{hidden} non-chat model{hidden === 1 ? '' : 's'} hidden (embeddings, audio…)</span></div>
                      ) : null}
                      {providerGroups.map((g) => (
                        <React.Fragment key={g.name}>
                          <div className="menu-head"><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ProviderIcon id={g.provider} size={14} />{g.name}</span></div>
                          <div className="model-list">
                            {g.models.map((m) => {
                              const badges = capabilityBadges(modelCapabilities(m));
                              return (
                                <button key={`${g.name}:${m}`} className="menu-item model-item" title={`Use ${m} from ${g.name}${modelScope === 'global' ? '' : ' for this chat only'}`} onClick={() => {
                                  // Cross-provider pick. The host switches provider per SCOPE:
                                  // 'global' → sets the shared default; 'session' → a per-chat
                                  // override (provider+model+endpoint, key resolved host-side) so
                                  // it never syncs to the other chats.
                                  pickModelRequest(m, g.name);
                                  q('q-snapshot', 'config-snapshot'); q('q-models', 'list-models');
                                }}>
                                  <span className="mi-check">{g.name === defaultProviderName && m === info.model ? '✓' : ''}</span>
                                  <ModelIcon model={m} style={{ marginRight: 6 }} />
                                  <span className="model-id">{m}</span>
                                  {badges.length ? (
                                    <span className="model-caps">
                                      {badges.map((b) => <span key={b.key} className={`cap-chip cap-${b.key}`} title={b.title}>{b.label}</span>)}
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        </React.Fragment>
                      ))}
                    </>
                  );
                })()}
                <button className="menu-item" onClick={() => { setPop(''); openSettings('models'); }}>
                  <span className="mi-check" />Custom model…
                </button>
                <div className="menu-sep" />
                <div className="menu-row">
                  <span>Apply to</span>
                  <button className="seg-toggle" title="Where a model pick is saved" onClick={() => setModelScope((s) => s === 'global' ? 'session' : 'global')}>
                    {modelScope === 'global' ? 'All chats' : 'This chat only'}
                  </button>
                </div>
              </div>
            ) : null}
            <button type="button" className={`model-pill${routerFallback ? ' router-fallback' : ''}${managedSelectionInvalid ? ' invalid' : ''}`}
              aria-label={`Model: ${info.model ?? 'none selected'}`}
              title={managedSelectionInvalid ? 'This managed model is unavailable. Choose another model.' : routerFallback ? `Router fallback: ${routerFallback}` : 'Choose model'} onClick={() => {
              if (pop !== 'model') { setModelsLoading(true); q('q-models', 'list-models'); q('q-account-models', 'account-model-catalog'); }
              setPop(pop === 'model' ? '' : 'model');
            }}>
              {routerFallback ? <span className="router-fallback-badge" aria-label="Router fallback">↷</span> : null}
              <span>{info.model ?? ''}</span>
            </button>
          </span>
          </span>
          {/* DESK-5s/5u — click the ring for a full context + usage breakdown. */}
          <span className="pop-wrap" style={hasConversation ? undefined : { display: 'none' }}>
            {pop === 'ctx' ? (
              <div className="menu-pop ctx-pop composer-ctx-pop">
                <div className="menu-head"><span>Context window</span></div>
                {contextUsage && contextUsage.window > 0 ? (
                  <UsageBar label="Model window" value={contextUsage.used} total={contextUsage.window}
                    tone={contextUsage.used / contextUsage.window >= 0.9 ? 'var(--warn)' : 'var(--accent)'} />
                ) : null}
                <UsageBar label="Until auto-compaction" value={contextUsage?.used ?? 0} total={contextUsage?.compactAt ?? 80000}
                  tone={(contextUsage?.pct ?? 0) >= 0.75 ? 'var(--warn)' : 'var(--accent)'} />
                <div className="ctx-note">Above the auto-compact line, BrainRouter summarizes old history and the context resets — shared with the CLI (<code>cli.autoCompactTokens</code>).</div>
                <div className="menu-sep" />
                <div className="menu-head"><span>This session</span></div>
                <div className="ctx-stats">
                  <div><b>{tokens ? tokens.promptTokens.toLocaleString() : '—'}</b><span>tokens in</span></div>
                  <div><b>{tokens ? tokens.completionTokens.toLocaleString() : '—'}</b><span>tokens out</span></div>
                  <div><b>{tokens?.turns ?? 0}</b><span>turns</span></div>
                </div>
                <button className="menu-item" onClick={() => { setPop(''); openSettings('observability'); }}>
                  <span className="mi-check" />Full usage breakdown<span className="mi-hint">→</span>
                </button>
              </div>
            ) : null}
            <button type="button" className="ctx-ring-btn" title="Context & usage" onClick={() => { if (pop !== 'ctx') q('q-ctx', 'context-usage'); setPop(pop === 'ctx' ? '' : 'ctx'); }}>
              <ContextRing usage={contextUsage} />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
