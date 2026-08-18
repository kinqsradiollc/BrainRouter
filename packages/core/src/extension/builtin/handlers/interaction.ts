// ADR-041 D8 — ask_user_choice: the batched structured-question picker (UI dialog
// via interactionPort, else the TTY prompter). Suppressed for silent children and
// under /yolo or an active /goal (the model decides itself, NoTTYError contract).
// Body is the former case body verbatim (`this.x` -> `host.x`).

import { readGoal } from '../../../goal/store/goalStore.js';
import { runHooks } from '../../../hooks/hooksStore.js';
import { NoTTYError } from '../../../agent/support/prompter.js';
import { traceEvent } from '../../../telemetry/tracing/tracing.js';
import { resolveActiveMode } from '../../../session/state/sessionModeStore.js';
import type { BuiltinToolHandler } from './registry.js';

export const interactionHandlers: Record<string, BuiltinToolHandler> = {
  ask_user_choice: async ({ args, host }) => {
        // PARITY — accept either the single-question fields or a batched
        // `questions[]` array (asked in turn, answers returned together). The
        // single form keeps its `{answer}` shape; batched returns `{answers}`.
        const rawQuestions: any[] = Array.isArray(args.questions) && args.questions.length
          ? args.questions
          : [{ question: args.question, header: args.header, options: args.options, multiSelect: args.multiSelect }];
        const specs = rawQuestions.map((rq, qi) => {
          const where = rawQuestions.length > 1 ? ` (question ${qi + 1})` : '';
          const q = String(rq?.question ?? '').trim();
          const h = String(rq?.header ?? '').trim();
          const rawOptions: any[] = Array.isArray(rq?.options) ? rq.options : [];
          if (!q) throw new Error(`ask_user_choice requires a non-empty \`question\`${where}.`);
          if (!h) throw new Error(`ask_user_choice requires a non-empty \`header\`${where}.`);
          if (rawOptions.length < 2 || rawOptions.length > 4) {
            throw new Error(`ask_user_choice requires 2–4 options${where}; received ${rawOptions.length}.`);
          }
          const options = rawOptions.map((o, i) => {
            const label = String(o?.label ?? '').trim();
            const description = String(o?.description ?? '').trim();
            if (!label) throw new Error(`ask_user_choice option ${i + 1}${where} is missing "label".`);
            if (!description) throw new Error(`ask_user_choice option ${i + 1}${where} is missing "description".`);
            return { label, description };
          });
          return { question: q, header: h, options, multiSelect: !!rq?.multiSelect };
        });
        const batched = specs.length > 1;
        // Back-compat aliases for the guard/trace code below (single-question).
        const question = specs[0].question;
        const options = specs[0].options;
        // Silent child agents have no parent stdin/REPL bridge, so the
        // helper's TTY check would error anyway — but giving a clearer message
        // up front saves the LLM an iteration.
        if (host.silent) {
          throw new NoTTYError(
            'ask_user_choice is not available to silent child agents. Decide the answer yourself, ' +
            'state which option you picked and why, and return that as your final answer to the parent.',
          );
        }
        // Autonomy bypass. The picker is suppressed in two cases:
        //
        //   1. /yolo on (executionMode=fast AND reviewPolicy=proceed) —
        //      the user has explicitly opted out of in-turn prompts.
        //   2. /goal active — the user has typed a goal and the auto-
        //      continuation loop is running; blocking on a picker
        //      stalls the whole reason /goal exists. The model decides
        //      itself and states which option in its reply.
        //
        // Both refusal messages use NoTTYError so the existing model
        // contract ("fall back to deciding yourself") fires verbatim.
        // A trace event records which axis triggered the bypass.
        const yoloPrefs = resolveActiveMode(host.workspaceRoot, host.sessionKey);
        const yoloOn = yoloPrefs.executionMode === 'fast' && yoloPrefs.reviewPolicy === 'proceed';
        const goalForPicker = readGoal(host.workspaceRoot, host.sessionKey);
        const goalActiveForPicker = !!(goalForPicker?.text && goalForPicker.status === 'active');
        if (yoloOn || goalActiveForPicker) {
          const reason = yoloOn && goalActiveForPicker ? 'yolo+goal' : yoloOn ? 'yolo' : 'goal';
          traceEvent('ask_user_choice.bypass', {
            reason,
            question,
            optionLabels: options.map((o) => o.label),
          });
          const triggerNote = yoloOn
            ? '/yolo (executionMode=fast + reviewPolicy=proceed)'
            : `the active /goal "${goalForPicker!.text.slice(0, 80)}${goalForPicker!.text.length > 80 ? '…' : ''}"`;
          throw new NoTTYError(
            `ask_user_choice was suppressed by ${triggerNote}. ` +
            'The user has explicitly opted out of in-turn prompts — pick the option you would pick, ' +
            'state which one you picked and why in your reply, and keep going. ' +
            (yoloOn
              ? 'Toggle off with /yolo off if you actually need to ask.'
              : 'Stop the goal with /goal pause or /goal clear if you actually need to ask.'),
          );
        }
        // Eager TTY check so we fail without disturbing the screen. askChoice
        // also checks (defense-in-depth for direct callers), but doing it here
        // means the LLM gets a clean error before the picker tries to render.
        // DESK-3 — UI dialog path: no TTY needed when an interaction port is
        // attached. A dismissed dialog mirrors the NoTTY contract verbatim.
        // Ask ONE spec, returning the chosen label(s). Same gates for every
        // spec — the DESK-3 UI dialog path when a port is attached, else the
        // TTY picker.
        const askOne = async (spec: { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }): Promise<string | string[]> => {
          // CC-hooks parity — the agent is about to BLOCK awaiting the user's
          // choice: fire `notification-agent-needs-input` so a user can wire a
          // desktop/OS notifier (the terminal is likely backgrounded). Advisory
          // and best-effort — a failing notifier must never break the picker.
          if (host.hookNotifyActive()) {
            try {
              runHooks(host.workspaceRoot, 'notification-agent-needs-input', {
                payload: { sessionKey: host.sessionKey, question: spec.question, header: spec.header, optionLabels: spec.options.map((o) => o.label) },
              });
            } catch { /* advisory */ }
          }
          if (host.interactionPort) {
            const labels = await host.interactionPort.choice({
              question: spec.question, header: spec.header, options: spec.options, multiSelect: spec.multiSelect,
            });
            if (!labels || labels.length === 0) {
              throw new NoTTYError(
                'The user dismissed the choice dialog. ' +
                'Fall back to deciding yourself and state which option you picked and why.',
              );
            }
            return spec.multiSelect ? labels : labels[0];
          }
          if (!host.prompter.getActiveReadline() || !process.stdin.isTTY) {
            throw new NoTTYError(
              'ask_user_choice requires an interactive TTY. ' +
              'Fall back to deciding yourself and state which option you picked and why.',
            );
          }
          // header is rendered by the picker itself (chip line at the top of
          // the frame), so we just thread it through opts.
          return await host.prompter.askChoice(spec.question, spec.options, { multiSelect: spec.multiSelect, header: spec.header });
        };

        if (!batched) {
          return JSON.stringify({ answer: await askOne(specs[0]) });
        }
        // Batched: ask each in turn, key answers by header (fallback question).
        // Disambiguate duplicate headers — they are ≤12 chars so collisions are
        // easy, and a plain `answers[header] = …` used to silently overwrite,
        // handing the model fewer answers than it asked. A repeated key gets a
        // ` (n)` suffix so every question's answer survives.
        const answers: Record<string, string | string[]> = {};
        for (let i = 0; i < specs.length; i++) {
          const spec = specs[i];
          const base = spec.header || spec.question;
          const key = base in answers ? `${base} (${i + 1})` : base;
          answers[key] = await askOne(spec);
        }
        return JSON.stringify({ answers });  },
};
