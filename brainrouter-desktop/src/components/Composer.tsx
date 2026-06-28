/**
 * T4 — the chat composer (input + slash popup + the controls row: mode, folder,
 * branch, effort, model, context ring). Extracted verbatim from App.tsx; the App
 * owns all state and passes it through (the popovers/menus are inline as before).
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import { ProviderIcon } from './ProviderIcon.js';
import { ModelIcon } from './ModelIcon.js';
import { SlashPopup } from '../palette.js';
import { UsageBar } from './UsageBar.js';
import { ContextRing } from './ContextRing.js';
import { EFFORT_LEVELS, NON_CHAT_MODEL } from '../constants.js';
import { modelCapabilities, capabilityBadges } from '../lib/models/modelCapabilities.js';
import type { AttachmentUpload, PopId } from '../types.js';
import type { DeskCommand, SettingsSection } from '../lib/commands/commands.js';
import { recognizedCommandToken } from '../lib/composer/slashHighlight.js';

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
  execMode: string;
  effort: string;
  info: { workspaceRoot?: string; model?: string };
  branches: { current: string | null; branches: string[]; loading?: boolean };
  endpointModels: string[];
  // §multi-select-models — the default provider's allowlist. When non-empty the
  // model menu lists only these (∩ the live endpoint list); empty ⇒ full list.
  allowedModels?: string[];
  // §connected-models — every saved provider (name + its allowlist/default), so
  // the model menu can list and switch to any connected provider, not just the
  // active endpoint. defaultProviderName marks which one is currently active.
  connectedProviders?: Array<{ name: string; provider: string; model: string; models?: string[]; endpoint?: string | null }>;
  defaultProviderName?: string | null;
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
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function Composer(p: ComposerProps): React.ReactElement {
  const {
    draft, setDraft, running, stopping, submit, requestStop, slashActive, slashMatches, commands,
    slashSel, setSlashSel, setSlashDismissed, onRunSlash, pop, setPop, q, modeLabel, execMode, effort,
    info, branches, endpointModels, allowedModels, connectedProviders, defaultProviderName, modelsLoading, setModelsLoading, modelChoices, modelScope, setModelScope,
    hasConversation, contextUsage, tokens, openSettings, onAttach, attachments = [], onClearAttachment, canSubmit = false,
  } = p;
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = React.useRef<HTMLDivElement | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const handleFiles = (list: FileList | null): void => {
    if (!list || !onAttach) return;
    const files = Array.from(list);
    if (files.length) onAttach(files);
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
  return (
    <div className="composer">
      <div
        className={`box${dragOver ? ' drag-over' : ''}`}
        onDragOver={onAttach ? (e) => { e.preventDefault(); if (!dragOver) setDragOver(true); } : undefined}
        onDragLeave={onAttach ? () => setDragOver(false) : undefined}
        onDrop={onAttach ? (e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); } : undefined}
      >
        {slashActive && slashMatches.length ? (
          <div className="slash-pop">
            <SlashPopup commands={commands} filter={draft} selected={slashSel} onPick={onRunSlash} onHover={setSlashSel} />
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
            onChange={(e) => { setDraft(e.target.value); setSlashSel(0); setSlashDismissed(false); }}
            onScroll={syncMirrorScroll}
            onKeyDown={(e) => {
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
          disabled={(!running && !draft.trim() && !canSubmit) || stopping}>{running ? <Icon name="stop" size={14} /> : <Icon name="arrow-up" size={14} />}</button>
        <div className="composer-controls">
          <span className="pop-wrap">
            {pop === 'mode' ? (
              <div className="menu-pop left">
                <div className="menu-head"><span>Mode</span><span>⇧⌃M</span></div>
                {([['Plan mode', 'planning', 'request', '1'], ['Accept edits', 'fast', 'request', '2'], ['Auto mode', 'fast', 'proceed', '3']] as const).map(([label, em, rp, num]) => (
                  <button key={label} className="menu-item" onClick={() => {
                    q('a-mode', 'action:set-session-mode', { executionMode: em, reviewPolicy: rp });
                    setPop('');
                  }}>
                    <span className="mi-check">{modeLabel === label ? '✓' : ''}</span>{label}
                    <span className="mi-hint">{num}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" className="chip dim" onClick={() => setPop(pop === 'mode' ? '' : 'mode')}>
              {modeLabel}<Icon name="chev-down" size={9} />
            </button>
          </span>
          <button type="button" className="ctx-chip" title={info.workspaceRoot}>
            <Icon name="folder" size={11} />
            <span>{info.workspaceRoot?.split('/').pop() ?? 'workspace'}</span>
          </button>
          <span className="pop-wrap">
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
          {/* DESK-5q — effort is its OWN control (Codex: Faster → Smarter) */}
          <span className="pop-wrap">
            {pop === 'effort' ? (
              <div className="menu-pop effort-menu">
                <div className="menu-head"><span>Effort</span><span>Faster → Smarter</span></div>
                {EFFORT_LEVELS.map((lvl) => (
                  <button key={lvl} className="menu-item" onClick={() => { q('a-mode', 'action:set-session-mode', { effort: lvl }); setPop(''); }}>
                    <span className="mi-check">{effort === lvl ? '✓' : ''}</span>{lvl === 'xhigh' ? 'Extra high' : lvl[0].toUpperCase() + lvl.slice(1)}
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" className="effort-pill" title="Reasoning effort" onClick={() => setPop(pop === 'effort' ? '' : 'effort')}>
              {effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1)}
            </button>
          </span>
          {/* model selection is now separate from effort */}
          <span className="pop-wrap">
            {pop === 'model' ? (
              <div className="menu-pop model-menu">
                {(() => {
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
                      <div className="menu-head"><span>Models{chatModels.length ? ` · ${chatModels.length} on endpoint` : ''}</span><span>⇧⌃I</span></div>
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
                              window.brainrouter.send({ kind: 'set-model', model: m, persist: modelScope === 'global' });
                              setPop('');
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
                                <button key={`${g.name}:${m}`} className="menu-item model-item" title={`Switch to ${g.name} and use ${m}`} onClick={() => {
                                  // Switch the active provider to this one, then pick the model.
                                  q('a-setdefault', 'action:set-default-provider', { name: g.name });
                                  setTimeout(() => { window.brainrouter.send({ kind: 'set-model', model: m, persist: true }); q('q-snapshot', 'config-snapshot'); q('q-models', 'list-models'); }, 150);
                                  setPop('');
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
                <div className="menu-row">
                  <span>Fast mode</span>
                  <button className={`switch${execMode === 'fast' ? ' on' : ''}`} onClick={() => {
                    q('a-mode', 'action:set-session-mode', { executionMode: execMode === 'fast' ? 'planning' : 'fast' });
                  }} />
                </div>
              </div>
            ) : null}
            <button type="button" className="model-pill" onClick={() => {
              if (pop !== 'model') { setModelsLoading(true); q('q-models', 'list-models'); }
              setPop(pop === 'model' ? '' : 'model');
            }}>
              {info.model ?? ''}{execMode === 'fast' ? ' · Fast' : ''}
            </button>
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
