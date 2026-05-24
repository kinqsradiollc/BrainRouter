import ora, { type Options, type Ora } from 'ora';

/**
 * Project-wide spinner factory. **Never** use `ora()` directly — always go
 * through this.
 *
 * `ora`'s default is `discardStdin: true`, which on every `.start()` invokes
 * the `stdin-discarder` dep (`process.stdin.setRawMode(true)` + add a noop
 * `data` listener + `process.stdin.resume()`), and on every `.stop()` /
 * `.succeed()` / `.fail()` does the inverse (`off` listener +
 * `process.stdin.pause()` + `process.stdin.setRawMode(false)`).
 *
 * The pause + raw-mode-false on stop is the load-bearing problem: the
 * brainrouter REPL's readline interface inherits that state, so after a
 * slash command that used a spinner (`/working`, `/handover`, `/explain`,
 * `/diagnostics`, `/forget`, `/persona`, `/skill-hints`, etc.) the prompt
 * looks alive but stdin is paused + cooked. Symptoms: Backspace echoes
 * `^?`, arrow keys echo `^[[A`, ENTER doesn't submit. Same class of bug
 * as the latent setRawMode(false) PR #30 removed at REPL startup, just
 * triggered per-spinner-stop instead of per-process-start.
 *
 * The agent turn (`runAgentTurn`) hides the symptom for most paths because
 * it brackets the whole turn in `rl.pause()` / `rl.resume()` — `rl.resume()`
 * re-engages raw mode via readline's internal `input._setRawMode(true)`.
 * Slash commands run outside that bracket, so the breakage surfaces there.
 * `ask_user_choice` pickers also show it after the picker cleanup hands
 * back to subsequent ora events that pause stdin again before the parent
 * turn's resume runs.
 *
 * `discardStdin: false` skips the entire stdin-discarder dance. The spinner
 * still renders identically; only the side effects are gone. No readline
 * plumbing changes, no `rl.pause()` / `rl.resume()` bracket needed at the
 * call sites — this is the right place to fix it.
 */
export function spinner(text: string, options: Omit<Options, 'text' | 'discardStdin'> = {}): Ora {
  return ora({ ...options, text, discardStdin: false });
}
