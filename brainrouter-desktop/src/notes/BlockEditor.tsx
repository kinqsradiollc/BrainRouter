/**
 * ADR-029 E1/E2 — one block's editing surface.
 *
 * **Why this is a contenteditable and not the textarea it replaces.** E2 stores
 * a block's marks IN its text as a markdown subset, and E4 requires those marks
 * to be RENDERED — bold that is bold, a mention that is a chip, a link you can
 * follow. A textarea cannot render anything: its value is one flat string, so
 * the only way to show a mark inside one is to show the delimiters, which is
 * the raw markdown E4 exists to stop showing. Everything else about the
 * textarea was better — the browser's own caret, its own selection, its own
 * undo — and giving those up is the cost this file pays for the marks.
 *
 * **The source string stays the truth; the DOM is a projection.** Every edit is
 * intercepted at `beforeinput`, computed against the string, and re-rendered.
 * Reading the edit back out of the DOM instead would mean re-deriving the marks
 * from the rendering, and that direction loses information: a `*` a person
 * typed literally and a `*` that opened an italic are the same character once
 * rendered. The caret is carried in source coordinates and mapped through
 * `lib/notes/blockEditing`, so a keystroke's landing place is a tested
 * judgement rather than whatever the browser happened to do.
 *
 * **The one edit that cannot be intercepted is a composition.** Chromium
 * refuses to let `insertCompositionText` be prevented, and re-rendering a block
 * while a candidate window is open cancels the composition and loses the
 * characters — so for the length of one composition the DOM is allowed to lead
 * the model, and exactly one commit lands at the end of it. That "exactly one"
 * is `reduceComposition`, and it is tested, because committing per update
 * writes the half-composed reading into the document and the person watches
 * their sentence rewrite itself as they type it.
 *
 * B2's lease survives the change: a block another device holds renders with
 * `contentEditable` off and keeps its attribution line, which is the decision
 * the lease exists for.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toggleInlineMark, type InlineMark } from '@kinqs/brainrouter-core/notes/editing';
import {
  backspaceEdit, deleteForwardEdit, EMPTY_HISTORY, inlineSegments, inputRuleStillApplies,
  previousBoundary, recordEdit, redoEdit, reduceComposition, replaceRange, sourceToVisible,
  textToShow, undoEdit, visibleToSource,
  type CompositionState, type EditHistory, type InlineSegment, type InputRuleTransformDto,
  type SourceSelection, type TextEdit,
} from '../lib/notes/blockEditing.js';
import { blockKeyIntent, stopsWindowShortcut, type BlockIntent } from '../lib/notes/blockKeymap.js';
import {
  caretEntryPoint, mergeRowRects, type RowRect, type VisualRowGeometry,
} from '../lib/notes/visualRows.js';
import { redoRoute, undoRoute } from '../lib/notes/pageUndo.js';
import {
  clearSlashTrigger, moveMenuSelection, slashPlan, slashTrigger,
  type SlashCommandDto, type SlashPlan,
} from '../lib/notes/slashMenu.js';
import {
  applyLinkToSelection, applyMentionPick, mentionTrigger,
  type MentionCandidate, type MentionTrigger,
} from '../lib/notes/mentionPicker.js';
import { CommandMenu, InlineToolbar, type CommandRow } from './EditorMenus.js';

/** How long a block waits before pushing a keystroke into the store. */
const PUSH_DEBOUNCE_MS = 350;

export interface BlockEditorProps {
  blockId: string;
  /** The block's text as the store last reported it. */
  text: string;
  kind: string;
  level: number | null;
  readOnly: boolean;
  placeholder: string;
  /** A3 — resolved labels for the references inside the text. */
  refLabels: Record<string, string>;
  onOpenRef: (uri: string) => void;
  /** The draft, on its way to `notes-update`. */
  onText: (text: string) => void;
  /** A structural gesture: core owns what it does, this only says which. */
  onIntent: (intent: BlockIntent, at: { text: string; caret: number }) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** Ask the host for what `# ` means. Null when nothing fired. */
  onInputRule: (request: {
    kind: string; text: string; caret: number; level?: number;
  }) => Promise<InputRuleTransformDto | null>;
  /** The rule fired: the block's kind changed as well as its text. */
  onRuleTransform: (transform: InputRuleTransformDto) => void;
  /** Core's catalog, through the host — never a second list in here. */
  searchSlash: (query: string) => Promise<SlashCommandDto[]>;
  onSlashPlan: (plan: SlashPlan, at: { text: string; caret: number }) => void;
  searchMentions: (query: string) => Promise<MentionCandidate[]>;
  /**
   * The parent asks this block to take the caret.
   *
   * `x` is F3's visual-row arrival: the caret enters at the same horizontal
   * position it left the previous block at, on this block's first or last laid
   * out row, and `caret` is the fallback for when there is no layout to
   * hit-test against. `adopt` is F4's: a page-level undo rewrote this block, and
   * a focused block otherwise keeps its own draft (`textToShow`) and would push
   * the pre-undo text straight back over it.
   */
  focusRequest: {
    caret: number;
    token: number;
    x?: number;
    edge?: 'first' | 'last';
    adopt?: boolean;
  } | null;
  /** F4 — this block's typing history is spent; ⌘Z belongs to the page now. */
  onPageHistory: (direction: 'undo' | 'redo') => void;
}

interface MenuState {
  type: 'slash' | 'mention';
  trigger: { at: number; query: string; as?: 'mention' | 'page' };
  /** Set for ⌘K, where the marked-up range is a selection rather than a marker. */
  over?: SourceSelection;
  index: number;
  rows: CommandRow[];
}

export function BlockEditor(props: BlockEditorProps): React.ReactElement {
  const {
    text, kind, level, readOnly, placeholder, refLabels, onOpenRef, onText, onIntent,
    onInputRule, onRuleTransform, searchSlash, searchMentions, onSlashPlan, focusRequest,
    onPageHistory,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(text);
  const draftRef = useRef(text);
  const lastPushedRef = useRef(text);
  const focusedRef = useRef(false);
  const composingRef = useRef<CompositionState>(null);
  /**
   * What this block will be left holding if core cuts it where the caret is.
   *
   * Enter is the one gesture whose answer rewrites the block it was pressed in,
   * and that answer arrives while the block still has focus — the caret only
   * moves to the new tail once the split has resolved. A focused block keeps its
   * draft (`textToShow`), so without this the head would show the whole line for
   * the rest of the session and write it back over the split on the next
   * keystroke. Nothing here decides what Enter DOES; core does, and this is only
   * how its answer is recognised among everything else the store may say.
   */
  const splitExpectation = useRef<string | null>(null);
  const caretRef = useRef<SourceSelection>({ start: 0, end: 0 });
  const historyRef = useRef<EditHistory>(EMPTY_HISTORY);
  const [caretVersion, setCaretVersion] = useState(0);
  const pushTimer = useRef<number | undefined>(undefined);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<MenuState | null>(null);
  const [toolbar, setToolbar] = useState<{ left: number; top: number } | null>(null);

  menuRef.current = menu;
  const segments = inlineSegments(draft);

  /* ------------------------------------------------------------- the store */

  // The judgement about which text wins lives in `blockEditing`: a focused
  // block keeps its draft, because the store's answer arrives several
  // keystrokes after the keystroke that caused it — except for the answer to
  // this block's own split, which `splitExpectation` is how it recognises.
  useEffect(() => {
    const next = textToShow({
      incoming: text, draft: draftRef.current,
      focused: focusedRef.current, lastPushed: lastPushedRef.current,
      expected: splitExpectation.current,
    });
    if (next === splitExpectation.current) {
      // Consumed once. Left standing it would go on matching a text the person
      // typed back by hand later, and the draft would lose to an old request.
      splitExpectation.current = null;
      // This text IS what the store holds, so there is nothing left to push and
      // the blur that follows the split must not send the head back again.
      lastPushedRef.current = next;
    }
    if (next !== draftRef.current) {
      draftRef.current = next;
      setDraft(next);
    }
  }, [text]);

  const flushPush = useCallback(() => {
    window.clearTimeout(pushTimer.current);
    if (draftRef.current === lastPushedRef.current) return;
    lastPushedRef.current = draftRef.current;
    onText(draftRef.current);
  }, [onText]);

  const schedulePush = useCallback(() => {
    window.clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(() => flushPush(), PUSH_DEBOUNCE_MS);
  }, [flushPush]);

  useEffect(() => () => window.clearTimeout(pushTimer.current), []);

  /* -------------------------------------------------------------- the caret */

  const readSelection = useCallback((): SourceSelection => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return caretRef.current;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer)) return caretRef.current;
    const here = inlineSegments(draftRef.current);
    const start = visibleToSource(here, visibleOffsetIn(root, range.startContainer, range.startOffset));
    const end = visibleToSource(here, visibleOffsetIn(root, range.endContainer, range.endOffset));
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }, []);

  const setCaret = useCallback((next: SourceSelection) => {
    caretRef.current = next;
    setCaretVersion((version) => version + 1);
  }, []);

  // After every render the caret is put back where the model says it is. React
  // has just replaced the text nodes underneath it, so the browser's own idea
  // of where it was is gone — and a gesture that works but drops the caret
  // fails E1's test as surely as one that does nothing.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !focusedRef.current || composingRef.current) return;
    const here = inlineSegments(draftRef.current);
    placeSelection(
      root,
      sourceToVisible(here, caretRef.current.start),
      sourceToVisible(here, caretRef.current.end),
    );
  }, [draft, caretVersion]);

  /**
   * F3 — where this block's rows and its caret actually are.
   *
   * Measured here because only the DOM knows; judged in `lib/notes/visualRows`
   * because "is this the first row" is the decision the dashboard has to make
   * identically. Returns null when there is nothing laid out yet, and the keymap
   * degrades to Part E's newline rule rather than refusing to move the caret.
   */
  const readGeometry = useCallback((): VisualRowGeometry | undefined => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return undefined;
    if (!root.contains(selection.getRangeAt(0).startContainer)) return undefined;

    const whole = document.createRange();
    whole.selectNodeContents(root);
    const rows = mergeRowRects(toRowRects(whole.getClientRects()));
    if (rows.length === 0) return undefined;

    const here = selection.getRangeAt(0).cloneRange();
    here.collapse(true);
    const caretRects = toRowRects(here.getClientRects());
    // A collapsed range at a boundary between two nodes reports nothing. The
    // element's own box is the honest fallback: it puts the caret on the first
    // row, which is where a boundary at offset zero actually is.
    const caret = caretRects[0] ?? { ...rows[0]!, left: rows[0]!.left };
    return { rows, caret: { top: caret.top, bottom: caret.bottom, left: caret.left } };
  }, []);

  /** Turn a viewport point into a source offset, for a caret arriving by x (F3). */
  const offsetAtPoint = useCallback((x: number, y: number): number | null => {
    const root = rootRef.current;
    if (!root) return null;
    const position = caretPositionAt(x, y);
    if (!position || !root.contains(position.node)) return null;
    const visible = visibleOffsetIn(root, position.node, position.offset);
    return visibleToSource(inlineSegments(draftRef.current), visible);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !focusRequest || readOnly) return;
    root.focus({ preventScroll: false });
    focusedRef.current = true;

    // F4 — a page-level undo rewrote this block. A focused block keeps its own
    // draft, so without adopting, the pre-undo text would be pushed straight
    // back over the undo on the next keystroke. The typing history goes with it:
    // its entries describe a text that no longer exists.
    if (focusRequest.adopt) {
      draftRef.current = text;
      setDraft(text);
      lastPushedRef.current = text;
      splitExpectation.current = null;
      historyRef.current = EMPTY_HISTORY;
    }

    // F3 — the caret enters at the x it left the previous block at, which is the
    // only thing that means the same on a wrapped paragraph as on a short line.
    // The character offset is the fallback: no layout (the harness before first
    // paint) and no `caretRangeFromPoint` in a headless run.
    if (focusRequest.x !== undefined) {
      const whole = document.createRange();
      whole.selectNodeContents(root);
      const rows = mergeRowRects(toRowRects(whole.getClientRects()));
      const point = caretEntryPoint(rows, focusRequest.edge ?? 'first', focusRequest.x);
      const landed = point ? offsetAtPoint(point.x, point.y) : null;
      if (landed !== null) { setCaret({ start: landed, end: landed }); return; }
    }
    setCaret({ start: focusRequest.caret, end: focusRequest.caret });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.token]);

  /* --------------------------------------------------------------- editing */

  const applyEdit = useCallback((edit: TextEdit, remember = true) => {
    if (remember) {
      historyRef.current = recordEdit(
        historyRef.current,
        { text: draftRef.current, caret: caretRef.current.start },
        edit,
      );
    }
    draftRef.current = edit.text;
    setDraft(edit.text);
    setCaret({ start: edit.caret, end: edit.caret });
    schedulePush();
  }, [schedulePush, setCaret]);

  /**
   * ⌘Z, which this editor has to provide itself.
   *
   * Every edit is computed here and the browser's is prevented, so the
   * browser's undo stack is empty — an editor where ⌘Z does nothing is one
   * people stop trusting with anything they care about.
   */
  const stepHistory = useCallback((direction: 'undo' | 'redo') => {
    const history = historyRef.current;
    // F4 — the routing judgement is in `lib/notes/pageUndo`, not here: this
    // block's typing first, and the PAGE's stack the moment there is none left.
    // That fall-through is what makes ⌘Z after a split undo the split rather
    // than doing nothing, which is the whole of F4's complaint.
    const route = direction === 'undo'
      ? undoRoute({ blockHasHistory: history.past.length > 0 })
      : redoRoute({ blockHasFuture: history.future.length > 0 });
    if (route === 'page') {
      // Anything typed but not yet pushed goes first, or the page's stack would
      // undo a state the store has never been told about.
      flushPush();
      onPageHistory(direction);
      return;
    }

    const current: TextEdit = { text: draftRef.current, caret: caretRef.current.start };
    const step = direction === 'undo'
      ? undoEdit(history, current)
      : redoEdit(history, current);
    if (!step) return;
    historyRef.current = step.history;
    applyEdit(step.edit, false);
  }, [applyEdit, flushPush, onPageHistory]);

  /** The menus re-evaluate after every edit — they open and close with the text. */
  const refreshMenus = useCallback((next: string, caret: number) => {
    if (kind === 'code') { setMenu(null); return; }
    const mention = mentionTrigger(next, caret);
    if (mention) {
      void searchMentions(mention.query).then((rows) => {
        if (draftRef.current !== next) return;
        setMenu({
          type: 'mention', trigger: mention, index: 0,
          rows: rows.map((row) => ({ id: row.uri, label: row.label, hint: row.mode, value: row })),
        });
      });
      return;
    }
    const slash = slashTrigger(next, caret);
    if (slash) {
      void searchSlash(slash.query).then((commands) => {
        if (draftRef.current !== next) return;
        setMenu({
          type: 'slash', trigger: slash, index: 0,
          rows: commands.map((command) => ({
            id: command.id, label: command.label, hint: command.hint,
            marker: command.marker, value: command,
          })),
        });
      });
      return;
    }
    setMenu(null);
  }, [kind, searchMentions, searchSlash]);

  /**
   * E1 — the marker becomes a heading the moment the space lands.
   *
   * Asked of the host so the rule is core's for every surface, and applied only
   * if the text is still the text it was asked about: the round trip is short
   * but not instant, and a person can type another character into it.
   */
  const tryInputRule = useCallback((next: string, caret: number) => {
    const requested = next;
    void onInputRule({ kind, text: next, caret, ...(level === null ? {} : { level }) })
      .then((transform) => {
        if (!transform) return;
        if (!inputRuleStillApplies(requested, draftRef.current)) return;
        draftRef.current = transform.text;
        setDraft(transform.text);
        setCaret({ start: transform.caret, end: transform.caret });
        lastPushedRef.current = transform.text;
        onRuleTransform(transform);
      })
      .catch(() => {});
  }, [kind, level, onInputRule, onRuleTransform, setCaret]);

  const insert = useCallback((selection: SourceSelection, data: string) => {
    const edit = replaceRange(draftRef.current, selection, data);
    applyEdit(edit);
    // A space (or a newline) is the moment every markdown marker completes, so
    // it is the only moment worth asking about — asking per character would put
    // a round trip on the typing path for nothing.
    //
    // The test is on the LAST character rather than on a single-character
    // insert: an input method, an autocorrect or a synthetic key can deliver
    // `- ` as one insertion, and a rule that only fired for a lone space would
    // work when typed slowly and not when typed quickly.
    if (data.endsWith(' ') || data.endsWith('\n')) tryInputRule(edit.text, edit.caret);
    refreshMenus(edit.text, edit.caret);
  }, [applyEdit, refreshMenus, tryInputRule]);

  /**
   * Enter, from either route that can deliver it.
   *
   * A keydown this editor prevents never becomes a `beforeinput`, so a real key
   * press arrives at `onKeyDown` and a synthetic insertion — an input method, a
   * driven event — arrives at `insertParagraph`. Both have to leave the same
   * expectation behind, or the gesture repairs itself when typed one way and
   * corrupts the block when typed the other.
   */
  const askForSplit = useCallback((caret: number) => {
    flushPush();
    splitExpectation.current = draftRef.current.slice(0, caret);
    onIntent({ kind: 'split' }, { text: draftRef.current, caret });
  }, [flushPush, onIntent]);

  const onBeforeInput = useCallback((event: InputEvent) => {
    const root = rootRef.current;
    if (!root) return;
    if (readOnly) { event.preventDefault(); return; }
    // A composition owns the DOM until it ends; see the header.
    if (composingRef.current || event.inputType.startsWith('insertCompositionText')) return;

    const selection = readSelection();
    const type = event.inputType;

    if (type === 'insertText' || type === 'insertReplacementText') {
      event.preventDefault();
      insert(selection, event.data ?? '');
      return;
    }
    if (type === 'insertFromPaste' || type === 'insertFromDrop') {
      event.preventDefault();
      // Pasted text goes in RAW, like typed text: a pasted `brainrouter://…` is
      // a live reference the moment it lands (B5 already treats it as one), and
      // escaping the paste would turn every link someone copies into text.
      const pasted = event.dataTransfer?.getData('text/plain') ?? '';
      insert(selection, pasted);
      return;
    }
    if (type === 'insertParagraph') {
      event.preventDefault();
      askForSplit(selection.start);
      return;
    }
    if (type === 'insertLineBreak') {
      event.preventDefault();
      insert(selection, '\n');
      return;
    }
    if (type === 'deleteContentBackward' || type === 'deleteWordBackward') {
      event.preventDefault();
      const range = type === 'deleteWordBackward'
        ? { start: wordStart(draftRef.current, selection.start), end: selection.end }
        : selection;
      const edit = backspaceEdit(draftRef.current, range);
      if (!edit) {
        flushPush();
        onIntent({ kind: 'merge-back' }, { text: draftRef.current, caret: 0 });
        return;
      }
      applyEdit(edit);
      refreshMenus(edit.text, edit.caret);
      return;
    }
    if (type === 'deleteContentForward' || type === 'deleteWordForward') {
      event.preventDefault();
      const edit = deleteForwardEdit(draftRef.current, selection);
      if (edit) { applyEdit(edit); refreshMenus(edit.text, edit.caret); }
      return;
    }
    if (type === 'historyUndo' || type === 'historyRedo') {
      event.preventDefault();
      stepHistory(type === 'historyUndo' ? 'undo' : 'redo');
      return;
    }
    // Anything this file does not model — the browser's own bold, a drag of
    // rendered HTML — is refused rather than allowed to write into the DOM
    // behind the model's back, which is how the two silently diverge.
    event.preventDefault();
  }, [applyEdit, askForSplit, flushPush, insert, onIntent, readOnly, readSelection, refreshMenus, stepHistory]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Native rather than React's synthetic `onBeforeInput`, which does not
    // carry `inputType` or the clipboard for every case we branch on.
    root.addEventListener('beforeinput', onBeforeInput as EventListener);
    return () => root.removeEventListener('beforeinput', onBeforeInput as EventListener);
  }, [onBeforeInput]);

  /* ----------------------------------------------------------- composition */

  const onCompositionStart = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const here = inlineSegments(draftRef.current);
    // The composition happens inside ONE text node, so the session records that
    // node's source range and reconciles the whole node at the end.
    const nodeStartVisible = visibleOffsetIn(root, node, 0);
    const nodeText = node.textContent ?? '';
    const step = reduceComposition(null, {
      type: 'start',
      source: draftRef.current,
      nodeStart: visibleToSource(here, nodeStartVisible),
      nodeEnd: visibleToSource(here, nodeStartVisible + nodeText.length),
      before: nodeText,
    });
    composingRef.current = step.state;
  }, []);

  const onCompositionEnd = useCallback((event: React.CompositionEvent<HTMLDivElement>) => {
    const node = window.getSelection()?.getRangeAt(0)?.startContainer ?? null;
    const after = node?.textContent ?? event.data ?? '';
    const step = reduceComposition(composingRef.current, { type: 'end', after });
    composingRef.current = null;
    if (!step.commit) return;
    applyEdit(step.commit);
    refreshMenus(step.commit.text, step.commit.caret);
  }, [applyEdit, refreshMenus]);

  /* -------------------------------------------------------------- the keys */

  const closeMenu = useCallback(() => setMenu(null), []);

  const pickMenuRow = useCallback((row: CommandRow) => {
    const open = menuRef.current;
    if (!open) return;
    if (open.type === 'slash') {
      const command = row.value as SlashCommandDto;
      const cleared = clearSlashTrigger(draftRef.current, open.trigger);
      const plan = slashPlan(command, cleared.text);
      // The block's own text is written first so the structural half never
      // races it: a plan that creates a block below would otherwise land while
      // the marker was still in this one.
      if (plan.action === 'set-kind') applyEdit(cleared);
      else { draftRef.current = cleared.text; setDraft(cleared.text); lastPushedRef.current = cleared.text; }
      setMenu(null);
      onSlashPlan(plan, cleared);
      return;
    }
    const candidate = row.value as MentionCandidate;
    const written = open.over
      ? applyLinkToSelection(draftRef.current, open.over, candidate)
      : applyMentionPick(
        draftRef.current,
        open.trigger as MentionTrigger,
        candidate,
        caretRef.current.end,
      );
    setMenu(null);
    applyEdit(written);
    flushPush();
  }, [applyEdit, flushPush, onSlashPlan]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const open = menuRef.current;
    const selection = readSelection();
    caretRef.current = selection;

    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setMenu({ ...open, index: moveMenuSelection(open.rows.length, open.index, event.key === 'ArrowUp' ? -1 : 1) });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const row = open.rows[open.index];
        if (row) pickMenuRow(row);
        return;
      }
      if (event.key === 'Escape') {
        // The `/` stays as the literal text someone typed — they may have been
        // typing a fraction, and eating it would be the editor taking a
        // character away from them.
        event.preventDefault();
        closeMenu();
        return;
      }
    }

    const intent = blockKeyIntent(event, {
      text: draftRef.current, selection, kind,
      menuOpen: open !== null, composing: composingRef.current !== null,
      // F3 — measured only for the keys that can use it. `getClientRects` forces
      // layout, and doing it on every keystroke would put a reflow between a
      // character and its appearing.
      ...(event.key === 'ArrowUp' || event.key === 'ArrowDown'
        ? { geometry: readGeometry() }
        : {}),
    });
    if (intent.kind === 'none') return;
    // ⌘K is quick find everywhere in the mode; over a selection it is a link.
    // Without this the shortcut that writes one also opens a panel over it.
    if (stopsWindowShortcut(intent)) event.stopPropagation();

    switch (intent.kind) {
      case 'newline':
        event.preventDefault();
        insert(selection, '\n');
        return;
      // The live route for Enter: preventing the keydown means the browser
      // never raises the `insertParagraph` this file also handles.
      case 'split':
        event.preventDefault();
        askForSplit(selection.start);
        return;
      case 'toggle-mark': {
        event.preventDefault();
        const toggled = toggleInlineMark({ text: draftRef.current, ...selection }, intent.mark as InlineMark);
        draftRef.current = toggled.text;
        setDraft(toggled.text);
        setCaret({ start: toggled.start, end: toggled.end });
        schedulePush();
        return;
      }
      case 'link':
        event.preventDefault();
        void searchMentions(draftRef.current.slice(selection.start, selection.end)).then((rows) => {
          setMenu({
            type: 'mention', trigger: { at: selection.start, query: '', as: 'mention' },
            over: selection, index: 0,
            rows: rows.map((row) => ({ id: row.uri, label: row.label, hint: row.mode, value: row })),
          });
        });
        return;
      case 'undo':
      case 'redo':
        event.preventDefault();
        stepHistory(intent.kind);
        return;
      case 'escape':
        closeMenu();
        return;
      default:
        event.preventDefault();
        flushPush();
        onIntent(intent, { text: draftRef.current, caret: selection.start });
    }
  }, [askForSplit, closeMenu, flushPush, insert, kind, onIntent, pickMenuRow, readGeometry, readSelection, schedulePush, searchMentions, setCaret, stepHistory]);

  /* -------------------------------------------------------- the toolbar */

  useEffect(() => {
    const onSelectionChange = (): void => {
      const root = rootRef.current;
      if (!root || !focusedRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) { setToolbar(null); return; }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) { setToolbar(null); return; }
      const rect = range.getBoundingClientRect();
      const base = root.getBoundingClientRect();
      setToolbar({ left: Math.max(0, rect.left - base.left), top: rect.top - base.top - 34 });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const toggleFromToolbar = useCallback((mark: InlineMark) => {
    const selection = readSelection();
    const toggled = toggleInlineMark({ text: draftRef.current, ...selection }, mark);
    draftRef.current = toggled.text;
    setDraft(toggled.text);
    setCaret({ start: toggled.start, end: toggled.end });
    schedulePush();
  }, [readSelection, schedulePush, setCaret]);

  const linkFromToolbar = useCallback(() => {
    const selection = readSelection();
    void searchMentions(draftRef.current.slice(selection.start, selection.end)).then((rows) => {
      setMenu({
        type: 'mention', trigger: { at: selection.start, query: '', as: 'mention' },
        over: selection, index: 0,
        rows: rows.map((row) => ({ id: row.uri, label: row.label, hint: row.mode, value: row })),
      });
    });
  }, [readSelection, searchMentions]);

  /* --------------------------------------------------------------- render */

  return (
    <div className="notes-editor">
      <div
        ref={rootRef}
        className={`notes-text notes-text-${kind}${level ? ` notes-h${level}` : ''}`}
        // B2 — a block another device holds is not editable, and the
        // attribution beside it is what makes that information rather than a
        // fault. The lease is the whole reason this is a prop and not a state.
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-readonly={readOnly}
        data-placeholder={placeholder}
        spellCheck
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onFocus={() => {
          focusedRef.current = true;
          // A caret arriving here is a fresh draft: whatever split this block
          // asked for has either landed or been answered with something else,
          // and an expectation kept past that would match a text somebody types
          // by hand much later.
          splitExpectation.current = null;
          caretRef.current = readSelection();
          props.onFocus();
        }}
        onBlur={() => {
          focusedRef.current = false;
          flushPush();
          setMenu(null);
          setToolbar(null);
          props.onBlur();
        }}
        onMouseUp={() => { caretRef.current = readSelection(); }}
        onClick={(event) => {
          // A chip is a link: following it is the gesture, and the caret work
          // above already keeps a click beside one out of its target.
          const uri = (event.target as HTMLElement).closest?.('[data-ref]')?.getAttribute('data-ref');
          if (uri) { event.preventDefault(); onOpenRef(uri); }
        }}
      >
        {segments.map((segment, index) => renderSegment(segment, index, refLabels))}
      </div>

      {toolbar && !readOnly ? (
        <InlineToolbar left={toolbar.left} top={toolbar.top} onToggle={toggleFromToolbar} onLink={linkFromToolbar} />
      ) : null}

      {menu ? (
        <CommandMenu
          rows={menu.rows}
          index={menu.index}
          empty={menu.type === 'slash' ? 'No command matches.' : 'Nothing in the workspace matches.'}
          onPick={pickMenuRow}
          onHover={(index) => setMenu((current) => (current ? { ...current, index } : current))}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- rendering */

/**
 * One parsed span as DOM.
 *
 * A reference is `contentEditable={false}` so the browser treats it as one
 * object: the caret goes around it rather than into a URL the reader cannot
 * see, and Backspace beside it removes the whole reference (which
 * `backspaceEdit` also decides, from the same ranges).
 */
function renderSegment(
  segment: InlineSegment,
  index: number,
  refLabels: Record<string, string>,
): React.ReactNode {
  const marks = segment.marks;
  const className = ['notes-inline', ...marks.map((mark) => `is-${mark}`)].join(' ');

  if (segment.mention) {
    return (
      <span
        key={index}
        className="notes-inline-ref"
        contentEditable={false}
        data-ref={segment.mention}
        // A3's resolved line is the TITLE rather than the chip's text, and the
        // block's own refs row below carries the live state. The rendered text
        // has to be the label that is in the string: the caret is measured in
        // rendered characters, so a chip a different length from what the
        // source says would put every caret after it on the line one place out.
        title={refLabels[segment.mention] ?? segment.mention}
      >
        {segment.text}
      </span>
    );
  }
  if (segment.page) {
    return (
      <span key={index} className="notes-inline-page" contentEditable={false}>{segment.text}</span>
    );
  }
  if (segment.href) {
    return (
      <span key={index} className={`${className} notes-inline-link`} data-ref={segment.href} title={segment.href}>
        {segment.text}
      </span>
    );
  }
  return <span key={index} className={className}>{segment.text}</span>;
}

/* ------------------------------------------------------------ DOM ↔ model */

/**
 * How much rendered text comes before a DOM position.
 *
 * A range from the start of the block to the position, measured by its own
 * text: the browser already knows how to walk its tree, and a hand-written walk
 * would have to get elements, chips and the empty block right to arrive at the
 * same number.
 */
function visibleOffsetIn(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  try {
    range.setEnd(node, offset);
  } catch {
    // A position that has just been removed by a re-render. The end of the
    // block is the honest answer; refusing would strand the caret.
    return (root.textContent ?? '').length;
  }
  return range.toString().length;
}

/**
 * A `DOMRectList` as the plain numbers `lib/notes/visualRows` decides on.
 *
 * The conversion is the boundary: everything past it is testable without a
 * browser, which is what stops the arrow keys' behaviour being something only
 * discoverable by typing.
 */
function toRowRects(rects: DOMRectList): RowRect[] {
  const out: RowRect[] = [];
  for (let at = 0; at < rects.length; at += 1) {
    const rect = rects[at]!;
    out.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
  }
  return out;
}

/**
 * The DOM position under a viewport point, across both spellings of the API.
 *
 * Chromium ships `caretRangeFromPoint`, the standard is
 * `caretPositionFromPoint`, and a headless runner may have neither. Returning
 * null rather than throwing is what makes the character-offset fallback in the
 * focus effect reachable instead of decorative.
 */
function caretPositionAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  const position = doc.caretPositionFromPoint?.(x, y);
  return position ? { node: position.offsetNode, offset: position.offset } : null;
}

function textNodesIn(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    out.push(node as Text);
    node = walker.nextNode();
  }
  return out;
}

function atomicAncestor(node: Node, root: HTMLElement): HTMLElement | null {
  let cursor: Node | null = node;
  while (cursor && cursor !== root) {
    if (cursor instanceof HTMLElement && cursor.isContentEditable === false) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}

/** Put the caret (or a range) at a rendered offset, never inside a chip. */
function placeSelection(root: HTMLElement, from: number, to: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const start = positionAt(root, from);
  const end = to === from ? start : positionAt(root, to);
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function positionAt(root: HTMLElement, visible: number): { node: Node; offset: number } {
  const nodes = textNodesIn(root);
  if (nodes.length === 0) return { node: root, offset: 0 };
  let remaining = Math.max(0, visible);
  for (const text of nodes) {
    if (remaining <= text.length) {
      const atomic = atomicAncestor(text, root);
      if (!atomic) return { node: text, offset: remaining };
      const parent = atomic.parentNode ?? root;
      const index = Array.prototype.indexOf.call(parent.childNodes, atomic);
      return { node: parent, offset: remaining === 0 ? index : index + 1 };
    }
    remaining -= text.length;
  }
  const last = nodes[nodes.length - 1]!;
  return { node: last, offset: last.length };
}

/** Where the word before `caret` begins — what ⌥Backspace takes. */
function wordStart(text: string, caret: number): number {
  let at = Math.min(Math.max(caret, 0), text.length);
  while (at > 0 && /\s/.test(text[at - 1]!)) at = previousBoundary(text, at);
  while (at > 0 && !/\s/.test(text[at - 1]!)) at = previousBoundary(text, at);
  return at;
}
