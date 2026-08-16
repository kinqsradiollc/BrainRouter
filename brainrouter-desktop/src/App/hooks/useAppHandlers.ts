/**
 * App shell — composer + attachment handlers (submit, AI PR review, file
 * attachments, pasted-image staging, header rename). Extracted from App.tsx
 * verbatim; every value they close over is passed on `ctx`, so behavior is
 * unchanged. Returned as a bundle the shell spreads back into local consts.
 */
import React from 'react';
import { mergeOptimistic } from '../../lib/session/list/sessionOrder.js';
import { withCachedProjectSessions } from '../../lib/session/workspaces/projectSessionsView.js';
import { runCommand, resolveSlashInput, type CmdCtx, type DeskCommand } from '../../lib/commands/commands.js';
import { buildPromptWithAttachments, readyAttachments } from '../../lib/attachments/attachmentPrompt.js';
import type { AttachmentUpload, ChatRow, SessionRow, ComponentTag } from '../../types.js';
import type { PanelId } from '../../panels/index.js';
import type { ProjectSessionsByRoot } from '../../lib/session/workspaces/projectSessionsView.js';

type Query = (id: string, name: string, args?: Record<string, unknown>) => void;

export interface AppHandlersCtx {
  q: Query;
  draft: string;
  setDraft: (d: string) => void;
  attachmentUploads: AttachmentUpload[];
  setAttachmentUploads: React.Dispatch<React.SetStateAction<AttachmentUpload[]>>;
  pastedImages: Array<{ id: string; mediaType: string; dataBase64: string }>;
  setPastedImages: React.Dispatch<React.SetStateAction<Array<{ id: string; mediaType: string; dataBase64: string }>>>;
  running: boolean;
  stopping: boolean;
  setToast: (t: string) => void;
  commands: DeskCommand[];
  cmdCtx: CmdCtx;
  runBridge: (cmd: string, argText?: string) => void;
  sessionKeyRef: React.MutableRefObject<string | undefined>;
  setRows: (val: ChatRow[] | ((prev: ChatRow[]) => ChatRow[])) => void;
  lastPromptRef: React.MutableRefObject<string>;
  goalContPendingRef: React.MutableRefObject<string | null>;
  setRunning: (v: boolean) => void;
  setSessionRunning: (key: string, running: boolean) => void;
  info: { sessionKey?: string; workspaceRoot?: string };
  setTurnStart: (t: number) => void;
  turnFailsRef: React.MutableRefObject<number>;
  branches: { current: string | null };
  pendingSessionsRef: React.MutableRefObject<SessionRow[]>;
  setSessions: React.Dispatch<React.SetStateAction<SessionRow[]>>;
  sessionsRef: React.MutableRefObject<SessionRow[]>;
  setProjSessions: React.Dispatch<React.SetStateAction<ProjectSessionsByRoot>>;
  activeWsRef: React.MutableRefObject<string | null>;
  workspaces: { current: string | null };
  refreshSession: () => void;
  ensurePanel: (id: PanelId) => void;
  /** ADR-028 G1 — make a panel available without taking focus. */
  offerPanel: (id: PanelId) => void;
  viewKey: string;
  componentTags: ComponentTag[];
  setComponentTags: React.Dispatch<React.SetStateAction<ComponentTag[]>>;
}

export interface AppHandlers {
  submit: (override?: string) => void;
  submitDelivery: (mode: 'queue' | 'steer') => void;
  reviewPrWithAi: (pr: { number: number; title?: string; headRefName?: string; baseRefName?: string }) => void;
  /** ADR-028 F7 — ask the agent for a comprehension review of its own work. */
  reviewMyUnderstanding: () => void;
  attachFiles: (files: File[]) => void;
  addPastedImages: (files: File[]) => void;
  renameCurrentSession: (title: string) => void;
}

export function useAppHandlers(ctx: AppHandlersCtx): AppHandlers {
  const {
    q, draft, setDraft, attachmentUploads, setAttachmentUploads, pastedImages, setPastedImages,
    running, stopping, setToast, commands, cmdCtx, runBridge, sessionKeyRef, setRows, lastPromptRef,
    goalContPendingRef, setRunning, setSessionRunning, info, setTurnStart, turnFailsRef, branches,
    pendingSessionsRef, setSessions, sessionsRef, setProjSessions, activeWsRef, workspaces, refreshSession,
    ensurePanel, offerPanel, viewKey, componentTags, setComponentTags,
  } = ctx;

  function submitWithDelivery(override: string | undefined, delivery: 'immediate' | 'queue' | 'steer'): void {
    const typedPrompt = (override ?? draft).trim();
    const pendingAttachments = attachmentUploads.filter((a) => a.status === 'reading' || a.status === 'attaching');
    const failedAttachments = attachmentUploads.filter((a) => a.status === 'failed');
    const attached = readyAttachments(attachmentUploads);
    // §vision — send images through the inline vision channel: pasted images PLUS
    // any attached image files (whose bytes we retained). Without this, attached
    // images only reach the model as extracted text/metadata and are invisible.
    const attachedImages = attached
      .filter((a) => !!a.dataBase64 && (a.mediaType?.startsWith('image/') || a.kind === 'image'))
      .map((a) => ({ mediaType: a.mediaType || 'image/png', dataBase64: a.dataBase64! }));
    const imagesToSend = [
      ...pastedImages.map((p) => ({ mediaType: p.mediaType, dataBase64: p.dataBase64 })),
      ...attachedImages,
    ];
    if (stopping || (running && delivery === 'immediate')) return;
    if (!running && delivery !== 'immediate') delivery = 'immediate';
    if (!typedPrompt && attached.length === 0 && imagesToSend.length === 0 && componentTags.length === 0) return;
    if (pendingAttachments.length > 0) {
      setToast(pendingAttachments.length === 1 ? `Still attaching ${pendingAttachments[0].name}…` : `Still attaching ${pendingAttachments.length} files…`);
      return;
    }
    if (failedAttachments.length > 0) {
      setToast(failedAttachments.length === 1 ? `Remove failed attachment ${failedAttachments[0].name} before sending.` : 'Remove failed attachments before sending.');
      return;
    }
    if (delivery !== 'immediate' && (attached.length > 0 || imagesToSend.length > 0 || componentTags.length > 0)) {
      setToast('Queue and Steer currently accept text only; send attachments after the active turn.');
      return;
    }
    // §vision — an image-only send (no typed text, no file attachments) gets a
    // sensible default question so the model has something to answer about it.
    const promptText = typedPrompt || (imagesToSend.length > 0 && attached.length === 0 ? "What's in this image?" : typedPrompt);
    const prompt = buildPromptWithAttachments(promptText, attached);
    // §a11y-inspect — dragged tags become reference blocks appended to the prompt:
    // component tags (open & fix, ref = `path:line#id`) and journey tags (explain
    // the ordered flow). Cleared after send.
    const compTags = componentTags.filter((t) => !t.steps);
    const journeyTags = componentTags.filter((t) => t.steps && t.steps.length);
    let finalPrompt = prompt;
    if (compTags.length) {
      finalPrompt += `\n\nTagged UI components (open & fix):\n${compTags.map((t) => `- ${t.name}${t.kind ? ` (${t.kind})` : ''} — ${t.ref}`).join('\n')}`;
    }
    if (journeyTags.length) {
      finalPrompt += `\n\nExplain these UI journeys (steps in order):\n${journeyTags.map((t) => `- ${t.name}:\n${(t.steps ?? []).map((st, i) => `    ${i + 1}. ${st.action} ${st.target}${st.text != null ? ` "${st.text}"` : ''}`).join('\n')}`).join('\n')}`;
    }
    const displayPrompt = typedPrompt
      || (attached.length === 1 ? `Use attached file: ${attached[0].name}`
        : attached.length > 1 ? `Use ${attached.length} attached files`
        : imagesToSend.length === 1 ? 'Pasted an image'
        : imagesToSend.length > 1 ? `Pasted ${imagesToSend.length} images`
        : componentTags.length === 1 ? `${componentTags[0].steps ? 'Explain' : 'Fix'} ${componentTags[0].name}`
        : `${componentTags.length} tagged UI items`);
    // T8 — a slash command is NEVER sent to the LLM. Route it through the
    // command registry: bridge runs against the CLI stores, known commands run
    // their wire (panel/settings/native/cli fallback), and an UNKNOWN slash
    // surfaces a command-output card instead of becoming a chat prompt.
    const slash = resolveSlashInput(typedPrompt, commands);
    if (slash.kind !== 'not-slash') {
      if (attached.length > 0 || imagesToSend.length > 0 || componentTags.length > 0) {
        setToast('Attachments, images, and tagged UI items are sent with chat messages, not slash commands.');
        return;
      }
      setDraft('');
      if (slash.kind === 'bridge') runBridge(slash.cmd, slash.args);
      else if (slash.kind === 'command') runCommand(slash.command, cmdCtx);
      else {
        const nowTs = Date.now();
        const stableCmdId = `${sessionKeyRef.current ?? 'global'}-cmd-out-${nowTs}-${typedPrompt.slice(0, 32).replace(/[^a-zA-Z0-9]/g, '_')}`;
        setRows((r) => [...r, { id: stableCmdId, kind: 'cmd-out', cmd: typedPrompt,
          lines: [`Unknown command \`${slash.base}\` — type \`/\` to browse commands, or run it in the terminal CLI.`], ts: nowTs }]);
      }
      return;
    }
    lastPromptRef.current = typedPrompt;
    // §goal-autonomy — a real user message preempts any queued goal continuation.
    goalContPendingRef.current = null;
    const nowTs = Date.now();
    const stableId = `${sessionKeyRef.current ?? 'global'}-user-${nowTs}-${displayPrompt.slice(0, 32).replace(/[^a-zA-Z0-9]/g, '_')}`;
    const deliveryState = delivery === 'queue' ? 'queued' : 'steered';
    setRows((r) => [...r, {
      id: stableId,
      kind: 'user',
      text: displayPrompt,
      ts: nowTs,
      ...(delivery !== 'immediate'
        ? { delivery: { id: stableId, mode: delivery, state: deliveryState } }
        : {}),
    }]);
    if (!override) setDraft('');
    if (attached.length > 0) setAttachmentUploads((prev) => prev.filter((a) => !attached.some((sent) => sent.id === a.id)));
    if (imagesToSend.length > 0) setPastedImages([]);
    if (componentTags.length > 0) setComponentTags([]);
    if (delivery !== 'immediate') {
      window.brainrouter.send({
        kind: 'start-turn',
        prompt: finalPrompt,
        delivery,
        deliveryId: stableId,
      });
      return;
    }
    setRunning(true);
    // DESK-5v — mark THIS session running so its spinner survives a switch away.
    setSessionRunning(sessionKeyRef.current ?? info.sessionKey ?? '', true);
    setTurnStart(Date.now());
    turnFailsRef.current = 0;
    // DESK-6t — show this chat in "Projects" IMMEDIATELY (optimistic row), so a
    // brand-new chat doesn't stay invisible in the sidebar until the turn ends.
    // refreshSession() shortly after reconciles it with the host-backed row.
    const sk = sessionKeyRef.current ?? info.sessionKey;
    if (sk) {
      // §session-pr — record the branch this session is running on so the sidebar
      // can show its live PR status; persisted via session meta + mirrored on the
      // optimistic row for an immediate icon.
      if (branches.current) q('q-session-branch', 'action:session-meta', { sessionKey: sk, patch: { branch: branches.current } });
      const optimistic: SessionRow = { sessionKey: sk, firstUserMessage: displayPrompt, modifiedAt: new Date().toISOString(), turnCount: 1, lastRole: 'user', branch: branches.current ?? null };
      // Wave 2 — track it as pending so subsequent list-sessions refreshes MERGE
      // it (instead of replacing it away) until the host transcript confirms it.
      if (!pendingSessionsRef.current.some((s) => s.sessionKey === sk)) pendingSessionsRef.current = [optimistic, ...pendingSessionsRef.current];
      setSessions((prev) => mergeOptimistic(prev.filter((s) => s.sessionKey !== sk), [optimistic]));
      sessionsRef.current = mergeOptimistic(sessionsRef.current.filter((s) => s.sessionKey !== sk), [optimistic]);
      setProjSessions((prev) => {
        const root = activeWsRef.current ?? info.workspaceRoot ?? workspaces.current;
        if (!root) return prev;
        const rows = mergeOptimistic((prev[root]?.rows ?? []).filter((s) => s.sessionKey !== sk), [optimistic]);
        return withCachedProjectSessions(prev, root, rows);
      });
      setTimeout(() => refreshSession(), 400);
    }
    window.brainrouter.send({ kind: 'start-turn', prompt: finalPrompt, ...(imagesToSend.length ? { images: imagesToSend } : {}) });
  }

  function submit(override?: string): void {
    submitWithDelivery(override, 'immediate');
  }

  function submitDelivery(mode: 'queue' | 'steer'): void {
    submitWithDelivery(undefined, mode);
  }

  // AI PR review — kick the agent to review a PR on an ISOLATED git worktree so
  // the user's working tree stays untouched. The agent creates the worktree with
  // its own shell, reads the diff, works the code-review checklist, gives a
  // verdict, and cleans up. Reuses the normal turn flow via submit(override).
  /**
   * ADR-028 F7 — the comprehension review, as a turn.
   *
   * The button was dead. `comprehension-start` in the host always returned an
   * empty question list, and the panel only renders when there ARE questions —
   * so clicking it did nothing, forever, which is exactly the failure this ADR
   * is about and I shipped it.
   *
   * The host cannot fix it: writing questions about consequences and rejected
   * alternatives needs the model that just did the work, and the host has no
   * model. So this mirrors `reviewPrWithAi` — the agent already has the
   * reasoning, the context and the tools. What was missing was the ask.
   */
  const reviewMyUnderstanding = (): void => {
    if (running || stopping) {
      setToast('Finish the current turn first.');
      return;
    }
    // The count comes from cli.comprehension.questions; five is the default the
    // resolver clamps to, and the agent is told the number rather than left to
    // pick one.
    const n = 5;
    const prompt = [
      `Write me a comprehension review of the work you just did — ${n} questions.`,
      '',
      'This is a code review pointed at MY understanding, not at the code. Rules:',
      '- Ask about CONSEQUENCES, RATIONALE, REVERSIBILITY and BOUNDARIES — what breaks if an assumption is wrong, why you rejected the alternative, which decision would be expensive to undo, what this deliberately does not handle.',
      '- Never ask trivia. "Which file is X in" tests nothing — I can grep. The value is entirely in what the diff cannot show.',
      '- Mix the forms: multiple choice where the wrong answers are plausible MISTAKES rather than filler, free text where recognising the answer is much easier than producing it, and at least one "this breaks when ___".',
      '- Every question carries an explanation, shown whether I am right or wrong. A wrong answer that teaches nothing is just a score.',
      '',
      'Then wait for my answers and judge them. Two rules on judging:',
      '- Different wording is FINE. You are judging whether I have the right model, not whether I phrased it your way.',
      '- **A wrong answer is not always mine.** You wrote this from your own reading of what I wanted, and that reading can be wrong in ways the tests do not catch. If my answer contradicts yours and my reasoning holds, say so and treat it as a defect report about the code rather than a mark against me.',
      '',
      'No score, no tally. Close by naming which parts I do not yet have a model of.',
    ].join('\n');
    submit(prompt);
  };

  const reviewPrWithAi = (pr: { number: number; title?: string; headRefName?: string; baseRefName?: string }): void => {
    if (running || stopping) {
      setToast('Finish the current turn before starting an AI review.');
      return;
    }
    const base = pr.baseRefName ? `\`${pr.baseRefName}\`` : 'the base branch';
    const head = pr.headRefName ? `\`${pr.headRefName}\`` : 'the PR branch';
    const wt = `.worktrees/pr-${pr.number}`;
    const prompt = [
      `Review pull request #${pr.number}${pr.title ? ` ("${pr.title}")` : ''} — ${head} → ${base}.`,
      `Do the review on an ISOLATED git worktree so my working tree stays untouched:`,
      `1. Check out the PR head into a worktree: \`git fetch origin pull/${pr.number}/head\` then \`git worktree add --detach ${wt} FETCH_HEAD\`.`,
      `2. Read the change in context using your READ-ONLY tools — don't judge from the diff alone: \`gh pr diff ${pr.number}\` (via \`run_command\`) for the diff, then \`read_file\` the changed files under \`${wt}\` and their neighbours.`,
      `3. Find the real blast radius — who depends on the changed files, so you know which callers to scrutinise for regressions. If the Atlas tools are available (check with \`mcp_search atlas\`), call \`atlas_query\` on each changed file to find its node, then \`atlas_impact\` for its dependents by layer. If Atlas is NOT available, get the same signal directly: \`grep_search\` for imports of each changed module and for uses of the exported symbols it changed, then \`read_file\` the top callers.`,
      `4. Work the review checklist: what is this change trying to achieve; does it actually achieve that (read the code, not the description); are there tests and did they actually validate the change; does it break existing functionality (check the dependents you found + adjacent behaviour); do you genuinely understand what the feature does. Every behaviour claim must cite a \`file:line\` you actually read, not an inference from a name.`,
      `5. Lead with a short Change summary (2-4 sentences) — what changed, why, and what it touches (from the dependents you found) — so a reviewer builds the mental model. Then give a clear verdict — approve or request changes — with specific \`file:line\` references for each point.`,
      `When finished, clean up: \`git worktree remove --force ${wt}\`.`,
    ].join('\n');
    submit(prompt);
  };

  // §5 — attach dropped/picked files: read each as base64 in the renderer and
  // ingest into a durable attachment record (the host preserves the original,
  // extracts text/metadata, links to memory) as a visible 'attachment' task.
  const attachFiles = (files: File[]): void => {
    const batch = files.slice(0, 8); // bound a stray multi-select
    const uploads = batch.map((file) => ({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      status: 'reading' as const,
    }));
    if (uploads.length) setAttachmentUploads((prev) => [...prev, ...uploads]);
    batch.forEach((file, index) => {
      const upload = uploads[index];
      const reader = new FileReader();
      reader.onload = () => {
        const out = reader.result;
        if (typeof out !== 'string') {
          setAttachmentUploads((prev) => prev.map((u) => u.id === upload.id ? { ...u, status: 'failed', detail: 'Could not read this file.' } : u));
          setToast(`✗ Could not read ${file.name}`);
          return;
        }
        const base64 = out.includes(',') ? out.slice(out.indexOf(',') + 1) : out;
        // §vision — an ATTACHED image must ALSO ride the vision sidecar so a
        // vision-capable model actually sees the pixels. The ingest path only
        // extracts text/metadata (invisible to the model), so retain the bytes +
        // mime on the upload; submit() forwards them via start-turn `images`.
        const isImage = file.type.startsWith('image/');
        setAttachmentUploads((prev) => prev.map((u) => u.id === upload.id
          ? { ...u, status: 'attaching', ...(isImage ? { mediaType: file.type || 'image/png', dataBase64: base64 } : {}) }
          : u));
        q(`q-attach:${upload.id}`, 'attachment-ingest', { name: file.name, dataBase64: base64 });
      };
      reader.onerror = () => {
        setAttachmentUploads((prev) => prev.map((u) => u.id === upload.id ? { ...u, status: 'failed', detail: 'Could not read this file.' } : u));
        setToast(`✗ Could not read ${file.name}`);
      };
      reader.readAsDataURL(file);
    });
    if (batch.length) {
      setToast(batch.length === 1 ? `Attaching ${batch[0].name}…` : `Attaching ${batch.length} files…`);
      // ADR-028 G1 — dropping a file is not a request to look at Tasks. The
      // tab appears with an unread dot; where you were looking is yours.
      offerPanel('tasks');
    }
  };

  // §vision — read pasted images as base64 and stage them for the next send (a
  // vision model receives them inline via start-turn `images`). Size-guarded and
  // capped; these bypass the text-extracting attachment pipeline by design.
  const addPastedImages = (files: File[]): void => {
    const imgs = files.filter((f) => f.type.startsWith('image/')).slice(0, 6);
    imgs.forEach((file) => {
      if (file.size > 12 * 1024 * 1024) { setToast(`Image too large (max 12 MB): ${file.name || 'pasted image'}`); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const out = reader.result;
        if (typeof out !== 'string') { setToast('✗ Could not read pasted image'); return; }
        const base64 = out.includes(',') ? out.slice(out.indexOf(',') + 1) : out;
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setPastedImages((prev) => [...prev, { id, mediaType: file.type || 'image/png', dataBase64: base64 }]);
      };
      reader.onerror = () => setToast('✗ Could not read pasted image');
      reader.readAsDataURL(file);
    });
  };

  // header rename — persist a new title for the currently-viewed session via the
  // SAME host write the sidebar's rename uses (action:session-meta → title). The
  // header drives this from its own local edit state (see ChatThread), so it
  // never collides with the sidebar's inline-rename input.
  const renameCurrentSession = (title: string): void => {
    const t = title.trim();
    if (viewKey && t) q('q-session-meta', 'action:session-meta', { sessionKey: viewKey, patch: { title: t } });
  };

  return { submit, submitDelivery, reviewPrWithAi, reviewMyUnderstanding, attachFiles, addPastedImages, renameCurrentSession };
}
