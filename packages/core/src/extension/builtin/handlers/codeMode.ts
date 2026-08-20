/**
 * ADR-041 A41-15 (W3) — the `run_code` (Code Mode) handler.
 *
 * The model writes ONE async program that calls the agent's tools as bindings
 * (`agent.read_file({...})`) instead of many tool-call turns. The program runs as
 * a subprocess (see `codeModeRunner`); every `agent.<tool>()` it makes is re-gated
 * through the FULL D8 pipeline via `ctx.codeModeDispatch` — byte-identical to the
 * model calling that tool directly — so Code Mode adds no authority the model
 * lacks. Budgets + kill are parent-side and OS-level.
 *
 * First slice: the child runs env-scrubbed but NOT OS-sandbox-wrapped, so this
 * REFUSES whenever the sandbox would be enforced — keeping it strictly ≤
 * `run_command`'s exposure in every mode. It is also default-OFF (`cli.codeMode.enabled`).
 */
import { getCliKnobs } from '../../../config/config.js';
import { decideExecutionPolicy } from '../../../exec/policy/execPolicy.js';
import { resolveSandboxConfig, scopeSecretEnv } from '../../../exec/runtime/sandbox.js';
import { readPreferences } from '../../../session/preferences/preferencesStore.js';
import { BUILTIN_TOOL_SPECS } from '../toolSpecs.js';
import { codeModeRunner } from '../../../exec/codeMode/codeModeRunner.js';
import { resolveCodeModeBudget } from '../../../exec/codeMode/budget.js';
import type { BuiltinToolHandler } from './registry.js';

const BOUND_TOOL_NAMES: readonly string[] = (BUILTIN_TOOL_SPECS as Array<{ name?: string }>)
  .map((spec) => spec?.name)
  .filter((n): n is string => typeof n === 'string' && n !== 'run_code');

export const codeModeHandlers: Record<string, BuiltinToolHandler> = {
  run_code: async ({ args, host, codeModeDispatch }) => {
    const source = String(args.source ?? '');
    if (!source.trim()) throw new Error('run_code requires a non-empty `source` program.');

    // Default-OFF: a new execution surface bakes behind an explicit flag.
    if (!getCliKnobs().codeMode?.enabled) {
      return 'Code Mode is disabled. Enable it with `cli.codeMode.enabled = true` in config.json.';
    }
    // Same shell gate as run_command (code can invoke shell tools).
    const shellPolicy = decideExecutionPolicy('shell', host.accessMode);
    if (shellPolicy.decision === 'deny') {
      return `run_code denied: ${shellPolicy.reason}.`;
    }
    // Pentest turns keep host egress off the tool path; run_code is refused there.
    if (host.pentestMode) {
      return 'run_code is unavailable on a pentest turn.';
    }
    // First slice runs UNSANDBOXED — refuse whenever run_command would be confined,
    // so run_code is never a weaker posture than run_command. (Sandbox-wrapping the
    // child to lift this refusal is the documented follow-on.)
    const prefs = readPreferences(host.workspaceRoot);
    const sandbox = resolveSandboxConfig(
      host.workspaceRoot,
      { readPaths: prefs.sandboxReadPaths, writePaths: prefs.sandboxWritePaths },
      { silent: host.silent, enforceWhenSilent: host.sandboxEnforceWhenSilent, forceEnforce: host.forceFleetSandbox },
    );
    if (sandbox.enabled) {
      return 'run_code is unavailable while the sandbox is enforced (unsandboxed Code Mode is a follow-on). Use run_command, which runs sandboxed.';
    }
    // A silent child with no way to answer an approval prompt cannot safely run a
    // program that may invoke gated tools — refuse, matching run_command.
    if (host.silent && !host.confirmToolApproval) {
      return 'run_code is unavailable to a silent child agent without a parent approval channel.';
    }
    // Without the D8 dispatch closure the program could not call tools safely.
    if (!codeModeDispatch) {
      return 'run_code is unavailable in this context (no tool-dispatch bridge).';
    }

    const budget = resolveCodeModeBudget(getCliKnobs().codeMode);
    const runner = host.codeRunnerPort ?? codeModeRunner;
    const result = await runner.runCode(
      source,
      {
        workspaceRoot: host.workspaceRoot,
        budget,
        toolNames: BOUND_TOOL_NAMES,
        signal: host.turnAbort?.signal,
        scrubbedEnv: scopeSecretEnv(process.env),
      },
      (tool, toolArgs) => codeModeDispatch(tool, toolArgs),
    );

    // Assemble a run_command-style block: the return value, the program's output
    // (capped), and a small footer. The turn loop offloads the whole thing if large.
    const parts: string[] = [];
    if (result.killReason) parts.push(`[run_code terminated: ${result.killReason}]`);
    if (result.error) parts.push(`Error:\n${result.error}`);
    parts.push(`Return value:\n${result.returnValue || '(none)'}`);
    if (result.output) parts.push(`Program output${result.outputTruncated ? ' (truncated)' : ''}:\n${result.output}`);
    parts.push(`[${result.toolCalls} tool call(s)]`);
    return parts.join('\n\n');
  },
};
