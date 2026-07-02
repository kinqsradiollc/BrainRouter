// REFAC-CHATAPP-SPLIT (0.4.17) — the scrollback + live-streaming subsystem,
// extracted verbatim from ChatApp.tsx. Owns the scrollback entry list, the id
// counter, the pinned child-fleet row id, and the TIER-A live assistant /
// reasoning stream buffers + throttled flush timer. Returns the state the
// component renders plus the `pushFns` (PushScrollback) object the orchestrator
// drives from outside the React tree. No behavior change: the logic here is a
// byte-for-byte move of what previously lived inline in ChatAppContent.
import { useState, useRef, useCallback, useMemo } from 'react';
import { estimateEntryHeight } from './layout.js';
import type { PushScrollback, ScrollbackEntry } from './types.js';

export interface ScrollbackState {
  scrollback: ScrollbackEntry[];
  setScrollback: React.Dispatch<React.SetStateAction<ScrollbackEntry[]>>;
  nextIdRef: React.MutableRefObject<number>;
  mainWidthRef: React.MutableRefObject<number>;
  scrollOffset: number;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  liveAssistant: string;
  liveReasoning: string;
  spinnerLabel: string;
  setSpinnerLabel: React.Dispatch<React.SetStateAction<string>>;
  phase: 'idle' | 'turn-running';
  setPhase: React.Dispatch<React.SetStateAction<'idle' | 'turn-running'>>;
  pushFns: PushScrollback;
}

export function useScrollbackState(
  seed: () => ScrollbackEntry[],
): ScrollbackState {
  const [scrollback, setScrollback] = useState<ScrollbackEntry[]>(seed);
  const nextIdRef = useRef(scrollback.length);
  // CC-P1.1 — scroll position in VISUAL LINES from the bottom of history
  // (0 = stuck to the latest output). Line-granular so w/s glide smoothly.
  const [scrollOffset, setScrollOffsetInternal] = useState(0);
  // width for push-time height estimates
  const mainWidthRef = useRef(80);
  const [phase, setPhase] = useState<'idle' | 'turn-running'>('idle');
  const [spinnerLabel, setSpinnerLabel] = useState<string>('');
  // TIER A: transient live-assistant + reasoning rows shown beneath the
  // scrollback while the model streams. Cleared when the agent fires
  // assistantDeltaEnd() and the final assistant() row lands in scrollback.
  const [liveAssistant, setLiveAssistant] = useState<string>('');
  const [liveReasoning, setLiveReasoning] = useState<string>('');
  // Throttle delta-driven setState to ~30Hz so a high-rate token stream
  // doesn't pin the Ink reconciler. We accumulate into a ref-buffer and
  // flush on a timer.
  const liveAssistantBufRef = useRef<string>('');
  // Reasoning is also streamed, and the *previous* implementation
  // replaced state with just the latest chunk — so the dim-italic row
  // flashed one token at a time instead of building up. We now
  // accumulate in a ref-buffer (same pattern as the assistant stream)
  // and render the trailing window so long chains-of-thought don't
  // dominate the viewport.
  const liveReasoningBufRef = useRef<string>('');
  // Single shared flush timer for BOTH assistant + reasoning streams.
  // Originally each had its own 33ms timer which meant two independent
  // setState calls per ~33ms, doubling the re-render rate of the entire
  // tree and producing visible flicker. Coalescing into one timer at
  // 80ms gives us ~12Hz which is still visually fluid for token
  // streaming while letting the reconciler breathe between frames.
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Back-compat aliases kept so any code path still touching the
  // per-stream timer refs (e.g. cancellation paths in turn-end) sees
  // the same shared timer. assistantDeltaEnd / assistant() clear via
  // these names; pointing both at the shared ref keeps that working.
  const liveAssistantFlushTimerRef = liveFlushTimerRef;
  const liveReasoningFlushTimerRef = liveFlushTimerRef;
  const scheduleLiveFlush = useCallback(() => {
    if (liveFlushTimerRef.current) return;
    liveFlushTimerRef.current = setTimeout(() => {
      liveFlushTimerRef.current = null;
      // Single render pass for both streams — React 18 auto-batches
      // setState calls in timers/microtasks, but being explicit makes
      // the intent clear: one frame, not two.
      setLiveAssistant(liveAssistantBufRef.current);
      setLiveReasoning(liveReasoningBufRef.current);
    }, 80);
  }, []);
  // Stable id of the pinned child-fleet row (when present). Lets
  // setChildFleet update the same row in place instead of churning a
  // new entry on every child tool event. -1 means no row currently shown.
  const childFleetIdRef = useRef<number>(-1);

  const pushFns = useMemo<PushScrollback>(() => {
    const push = (entry: any) => {
      // Stick to the bottom ONLY when already at the bottom. If the user has
      // scrolled up to read history, keep their viewport LINE-anchored: bump
      // the line offset by the new entry's estimated height so the content
      // they're reading doesn't shift (the old yank-on-every-push bug).
      setScrollOffsetInternal((prev) => {
        if (prev <= 0) return 0;
        const h = Math.max(1, estimateEntryHeight({ id: -1, timestamp: new Date(), ...entry } as ScrollbackEntry, mainWidthRef.current));
        return prev + h;
      });
      setScrollback((s) => {
        const id = ++nextIdRef.current;
        return [...s, { id, timestamp: new Date(), ...entry } as ScrollbackEntry];
      });
    };
    return {
      raw: (text, opts) => push({ kind: 'raw', text, noWrap: opts?.noWrap }),
      user: (text) => { setScrollOffsetInternal(0); push({ kind: 'user', text }); },
      assistant: (text, meta) => {
        // The final assistant message for the turn is landing — clear
        // any leftover live-stream state so we don't double-render it.
        if (liveAssistantFlushTimerRef.current) {
          clearTimeout(liveAssistantFlushTimerRef.current);
          liveAssistantFlushTimerRef.current = null;
        }
        if (liveReasoningFlushTimerRef.current) {
          clearTimeout(liveReasoningFlushTimerRef.current);
          liveReasoningFlushTimerRef.current = null;
        }
        liveAssistantBufRef.current = '';
        liveReasoningBufRef.current = '';
        setLiveAssistant('');
        setLiveReasoning('');
        push({ kind: 'assistant', text, ...meta });
      },
      tool: (header, ok, opts) => push({ kind: 'tool', header, ok, ...opts }),
      memory: (level, text) => push({ kind: 'memory', level, text }),
      plan: (items, explanation) => push({ kind: 'plan', items, explanation }),
      notice: (text, level) => push({ kind: 'notice', text, level: level ?? 'info' }),
      agentResult: (event) => push({ kind: 'agent-result', childId: event.childId, role: event.role, status: event.status, body: event.body }),
      setStatus: (label) => setSpinnerLabel(label),
      setPhase: (p) => setPhase(p),
      assistantDeltaStart: () => {
        // A new LLM call is streaming. If there's leftover text from a
        // PRIOR call in this same turn (model emitted a preamble, then
        // tool-called, now coming back for the real answer), commit it
        // as its own scrollback row first so it doesn't vanish. Same
        // treatment for the reasoning buffer.
        const carryAssistant = liveAssistantBufRef.current;
        if (carryAssistant && carryAssistant.trim()) {
          push({ kind: 'assistant', text: carryAssistant });
        }
        const carryReasoning = liveReasoningBufRef.current;
        if (carryReasoning && carryReasoning.trim()) {
          push({ kind: 'reasoning', text: carryReasoning });
        }
        if (liveAssistantFlushTimerRef.current) {
          clearTimeout(liveAssistantFlushTimerRef.current);
          liveAssistantFlushTimerRef.current = null;
        }
        if (liveReasoningFlushTimerRef.current) {
          clearTimeout(liveReasoningFlushTimerRef.current);
          liveReasoningFlushTimerRef.current = null;
        }
        liveAssistantBufRef.current = '';
        liveReasoningBufRef.current = '';
        setLiveAssistant('');
        setLiveReasoning('');
      },
      assistantDelta: (chunk) => {
        liveAssistantBufRef.current += chunk;
        scheduleLiveFlush();
      },
      assistantDeltaEnd: () => {
        // Stop appending and flush whatever's pending so the visible
        // row matches the model's final text. Do NOT clear — clearing
        // here was the "text vanishes" bug: for intermediate LLM calls
        // (preamble → tool → real answer) the text gets wiped before
        // anything commits it. We let it persist; the NEXT
        // assistantDeltaStart commits it as a row, and the final
        // assistant(...) push clears the live state with metadata.
        if (liveAssistantFlushTimerRef.current) {
          clearTimeout(liveAssistantFlushTimerRef.current);
          liveAssistantFlushTimerRef.current = null;
        }
        setLiveAssistant(liveAssistantBufRef.current);
        // Commit the reasoning block to scrollback so the chain-of-thought
        // persists for scrollback review. The next LLM call's reasoning
        // gets its own block via assistantDeltaStart's carry-commit.
        if (liveReasoningFlushTimerRef.current) {
          clearTimeout(liveReasoningFlushTimerRef.current);
          liveReasoningFlushTimerRef.current = null;
        }
        const finalReasoning = liveReasoningBufRef.current;
        if (finalReasoning && finalReasoning.trim()) {
          push({ kind: 'reasoning', text: finalReasoning });
        }
        liveReasoningBufRef.current = '';
        setLiveReasoning('');
      },
      reasoningDelta: (chunk) => {
        // Stream the FULL reasoning the same way prose streams: append
        // to the buffer and render the whole thing in a dim-italic
        // block. Throttled to ~33Hz so a fast token rate doesn't pin
        // Ink. On call-end the buffer is committed to scrollback as a
        // persistent `reasoning` entry so users can scroll back and
        // read it later.
        const safe = chunk.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
        liveReasoningBufRef.current += safe;
        scheduleLiveFlush();
      },
      compaction: (event) => push({ kind: 'compaction', droppedMessages: event.droppedMessages, keptMessages: event.keptMessages, summary: event.summary }),
      setChildFleet: (children) => {
        setScrollback((rows) => {
          const currentId = childFleetIdRef.current;
          // Empty → remove the pinned row (if any).
          if (children.length === 0) {
            if (currentId < 0) return rows;
            childFleetIdRef.current = -1;
            return rows.filter((r) => r.id !== currentId);
          }
          // Existing row → update in place.
          if (currentId >= 0) {
            const idx = rows.findIndex((r) => r.id === currentId);
            if (idx >= 0) {
              const next = rows.slice();
              next[idx] = { id: currentId, kind: 'child-fleet', children };
              return next;
            }
          }
          // New row → push and remember id.
          const id = ++nextIdRef.current;
          childFleetIdRef.current = id;
          return [...rows, { id, kind: 'child-fleet', children }];
        });
      },
      spawnBatch: (children) => {
        if (children.length === 0) return;
        const names = children.map((c) => {
          const idShort = c.childId.startsWith('agent-') ? c.childId.slice(0, 14) : `agent-${c.childId.slice(0, 8)}`;
          return `${idShort} (${c.role})`;
        }).join(', ');
        const prefix = children.length > 1
          ? `🚀 Spawned ${children.length} agents in parallel`
          : `🚀 Spawned 1 agent`;
        push({ kind: 'notice', text: `${prefix}: ${names}`, level: 'info' });
      },
    };
  }, []);

  return {
    scrollback,
    setScrollback,
    nextIdRef,
    mainWidthRef,
    scrollOffset,
    setScrollOffset: setScrollOffsetInternal,
    liveAssistant,
    liveReasoning,
    spinnerLabel,
    setSpinnerLabel,
    phase,
    setPhase,
    pushFns,
  };
}
