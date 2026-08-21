/**
 * Fail-closed authorization for one prepared tool call.
 *
 * Intersects skill, workspace, declarative permission, access-mode, shell,
 * approval, external-directory, and required-workflow constraints before any
 * local, orchestration, or MCP adapter may run.
 */
import path from 'node:path';
import type { Agent, RunTurnCallbacks } from '../agent.js';
import { commandWritesFiles } from '../guards/verificationGate.js';
import { assessMcpToolApproval } from '../guards/mcpApproval.js';
import { getCliKnobs } from '../../config/config.js';
import { recordTrajectoryEvent } from '../../session/trace/trajectoryStore.js';
import {
  externalDirectoryDecision,
  resolveToolPolicy,
} from '../../exec/policy/execPolicy.js';
import { isPathWithinRoots } from '../../exec/policy/pathPolicy.js';
import {
  evaluatePermissionRules,
  primaryArgText,
} from '../../exec/policy/permissionRules.js';
import { classifyShellCommand } from '../../exec/policy/shellClassifier.js';
import { recordDenial } from '../../exec/runtime/recentDenials.js';
import {
  registryToolAllowed,
  WORKER_THREAD_TOOLS,
} from '../../tool/registry/registry.js';
import { traceEvent } from '../../telemetry/tracing/tracing.js';
import { planExecutionBlockReason } from '../../task/planPhases.js';
import { readPlan } from '../../task/taskStore.js';
import {
  requiredSkillsBlockingMutation,
  type RequiredSkillActivation,
} from '../../workspace/requiredSkillActivation.js';

export interface ToolAuthorizationInput {
  agent: Agent;
  callbacks: RunTurnCallbacks;
  name: string;
  args: Record<string, unknown> | null;
  isLocal: boolean;
  mcpTool?: unknown;
  skillAllowsTool(name: string): boolean;
  workspaceAllowsLocalTool(name: string): boolean;
  workspaceAllowsMcpTool(tool: unknown): boolean;
  /** Dispatch-time copy of the complete hard surface; schema hiding alone is never authority. */
  hardSurfaceAllowsTool(name: string, isLocal: boolean, descriptor?: unknown): boolean;
  requiredSkillActivation: RequiredSkillActivation;
  loadedRequiredSkills: ReadonlySet<string>;
  attemptedRequiredSkills: ReadonlySet<string>;
  /**
   * ADR-027 D3 — per-turn record of skills we already warned about, so a
   * degraded workflow reports ONCE rather than on every mutating call.
   * Notification acceptance decays sharply with repetition.
   */
  warnedRequiredSkills?: Set<string>;
  /** Exact consumed PhasePlan intent supplies its own bounded execution plan. */
  trustedExecutionLaunch?: boolean;
  /** Side-effect-free policy recheck after an async hook/approval boundary. */
  revalidation?: boolean;
  trace: { traceId: string; spanId: string };
}

/** These RPCs carry server-pinned identity or mutate the learned lifecycle.
 * They are called by trusted host code directly through the MCP client and are
 * intentionally absent from the model inventory. A guessed prefixed name must
 * still be refused here because the pool's legacy resolver accepts names that
 * were never advertised. */
const HOST_ONLY_MCP_RAW_TOOLS = [
  'memory_learning_identity',
  'memory_learned_lifecycle',
  'memory_learned_revert',
  'memory_learned_sync',
  'memory_record_learned',
] as const;

export function isHostOnlyMcpModelDispatch(name: string, descriptor?: unknown): boolean {
  const rawName = descriptor && typeof descriptor === 'object'
    ? String((descriptor as { __rawName?: unknown }).__rawName ?? '')
    : '';
  return HOST_ONLY_MCP_RAW_TOOLS.some((raw) => (
    name === raw || name.endsWith(`_${raw}`) || rawName === raw
  ));
}

export function authorizeToolCall(input: ToolAuthorizationInput): void {
  const {
    agent,
    callbacks,
    name,
    args,
    isLocal,
  } = input;
  const diagnosticName = name
    .replace(/[^A-Za-z0-9_.:-]/g, '?')
    .slice(0, 120);
  const deny = (reason: string): never => {
    try {
      recordDenial(
        agent.workspaceRoot,
        agent.sessionKey,
        diagnosticName,
        reason,
      );
    } catch {
      // Denial diagnostics are best-effort; authorization remains fail-closed.
    }
    throw new Error(reason);
  };

  if (!isLocal && isHostOnlyMcpModelDispatch(name, input.mcpTool)) {
    deny(`Tool "${diagnosticName}" denied: host-only learned-memory RPCs cannot be model-dispatched.`);
  }

  if (
    isLocal
    && WORKER_THREAD_TOOLS.has(name)
    && agent.inheritedExecutionAuthorityGuard() !== undefined
    && agent.executionIntentTurnToolName() === null
  ) {
    deny(
      `Tool "${diagnosticName}" denied: detached worker lifecycle tools are unavailable inside inherited reviewed execution.`,
    );
  }

  if (name !== 'reconcile_steer' && !input.skillAllowsTool(name)) {
    deny(
      `Tool "${diagnosticName}" denied by the active skill allowed-tools policy.`,
    );
  }
  if (
    isLocal &&
    name !== 'reconcile_steer' &&
    !input.workspaceAllowsLocalTool(name)
  ) {
    deny(
      `Tool "${diagnosticName}" denied by the active workspace tool-profile policy.`,
    );
  }
  if (!isLocal && !input.workspaceAllowsMcpTool(
    input.mcpTool ?? { name, __rawName: name },
  )) {
    deny(
      `Tool "${diagnosticName}" denied by the active workspace MCP tool policy.`,
    );
  }

  // The exact dispatch ceiling is the final name-level intersection after the
  // more specific skill/workspace checks above. Keeping it before permissions,
  // approval, hooks, and adapters still prevents every side effect, while
  // preserving the actionable policy reason for ordinary denied calls.
  if (name !== 'reconcile_steer' && !input.hardSurfaceAllowsTool(name, isLocal, input.mcpTool)) {
    deny(
      `Tool "${diagnosticName}" denied: it is outside the active capability, role, delegated-authority, availability, or user tool ceiling.`,
    );
  }

  const knobs = getCliKnobs();
  const permissionNames = [name];
  if (!isLocal && input.mcpTool && typeof input.mcpTool === 'object') {
    const rawName = String((input.mcpTool as { __rawName?: unknown }).__rawName ?? '').trim();
    if (rawName && rawName !== name) permissionNames.push(rawName);
  }
  let ruleDecision: 'allow' | 'deny' | null = null;
  for (const permissionName of permissionNames) {
    const decision = evaluatePermissionRules(
      knobs.permissions,
      permissionName,
      primaryArgText(permissionName, args),
      { workspace: agent.workspaceRoot },
    );
    if (decision === 'deny') {
      ruleDecision = 'deny';
      break;
    }
    if (decision === 'allow') ruleDecision = 'allow';
  }
  if (ruleDecision === 'deny') {
    deny(`Tool "${name}" denied: matched a cli.permissions deny rule.`);
  }

  if (name === 'run_command' && knobs.autoClassifyShell !== 'off') {
    const command = String(args?.command ?? '');
    const verdict = classifyShellCommand(command, {
      mode: knobs.autoClassifyShell,
      silent: agent.silent,
      enforceWhenSilent: knobs.autoClassifyShellEnforceWhenSilent,
      allowlist: knobs.commandAllowlist,
      destructiveContext: { userIntent: agent.lastUserPrompt },
    });
    if (verdict.decision === 'deny') {
      deny(
        `Tool "${name}" denied by autoClassifyShell (${verdict.rule}): ${verdict.reason}`,
      );
    }
    if (verdict.decision === 'ask' && agent.silent) {
      deny(
        `Tool "${name}" flagged by autoClassifyShell but this session can't ` +
        `prompt (fail-closed) (${verdict.rule}): ${verdict.reason}`,
      );
    }
  }

  const policy = resolveToolPolicy(name, agent.accessMode, args);
  const mcpNeedsApproval =
    !isLocal &&
    assessMcpToolApproval(name, input.mcpTool).requiresApproval;
  if (policy.mutating || mcpNeedsApproval) {
    const blockedSkills = requiredSkillsBlockingMutation(
      input.requiredSkillActivation,
      input.loadedRequiredSkills,
    );
    const disabledSkill = blockedSkills.find(
      (skill) => skill.availability === 'disabled',
    );
    if (disabledSkill) {
      deny(
        `Tool "${name}" paused: required skill "${disabledSkill.id}" is ` +
        'disabled for this workspace. Enable it or revise the task before ' +
        'mutating.',
      );
    }
    // ADR-027 D3 — narrow, evidenced degradation. Three cases:
    //
    //   1. DISABLED (handled above)   -> deny. User intent, not a failure.
    //   2. NOT ATTEMPTED              -> deny. No evidence the skill is
    //      unloadable; this is the preflight-race case and stays fail-closed.
    //   3. ATTEMPTED AND FAILED       -> warn once, proceed.
    //
    // Security review flagged case 3 as fail-open authorization (CWE-863). We
    // considered it and disagree, for three reasons:
    //
    //   a) This is a WORKFLOW PRECONDITION, not a privilege boundary. It
    //      enforces "load the planning workflow before mutating"; it grants and
    //      restricts nothing. The actual authorization boundaries — access
    //      mode, exec policy, permission rules, path policy, approval — are
    //      untouched and remain fail-closed.
    //   b) The threat model does not close, because the bypass is REDUNDANT
    //      with a capability the same actor already holds. The required-skill
    //      set is derived from the workspace manifest (see
    //      resolveRequiredSkillActivation: `input.manifest.skills` /
    //      `.planning` / `.profile`), which lives in the opened repository. An
    //      actor who controls repository contents — enough to ship a malformed
    //      SKILL.md — controls WHICH skills are required in the first place.
    //      To make this gate not fire they simply declare no required skills,
    //      or ship no manifest. Corrupting a skill file is a strictly harder
    //      path to an outcome they can already have for free, so denying here
    //      removes no attacker capability.
    //   c) Fail-closed is the WORSE outcome under the reviewer's own scenario:
    //      corrupting one SKILL.md would brick the agent entirely, making this
    //      a trivial denial-of-service on the user's own tool. Degrading with a
    //      visible warning is strictly safer than wedging.
    if (blockedSkills.length > 0) {
      const notAttempted = blockedSkills.filter((skill) =>
        !input.attemptedRequiredSkills.has(skill.id));
      if (notAttempted.length > 0) {
        deny(
          `Tool "${name}" not dispatched because required workflow skill(s) are not ready: ` +
          `${notAttempted.map((skill) => skill.id).join(', ')}. ` +
          'Continue read-only diagnosis or report the blocked prerequisite; do not retry this mutation.',
        );
      }
      const unresolved = blockedSkills.map((skill) => skill.id);
      const unwarned = input.warnedRequiredSkills
        ? unresolved.filter((id) => !input.warnedRequiredSkills!.has(id))
        : unresolved;
      if (unwarned.length > 0 && !input.revalidation) {
        for (const id of unwarned) input.warnedRequiredSkills?.add(id);
        callbacks.onNotice?.({
          level: 'warn',
          message:
            'Proceeding without required workflow skill(s) the host could not load: ' +
            `${unwarned.join(', ')}. Their guidance is unavailable for this turn, ` +
            'so review the result more closely than usual.',
        });
      }
    }
    const planningRequired = input.requiredSkillActivation.required.some(
      (skill) =>
        skill.id === 'planning-skill' &&
        skill.availability === 'available',
    );
    const phaseGatedMutation =
      mcpNeedsApproval ||
      (
        policy.mutating &&
        (
          name !== 'run_command' ||
          commandWritesFiles(String(args?.command ?? ''))
        )
      );
    if (planningRequired && phaseGatedMutation && !input.trustedExecutionLaunch) {
      const plan = readPlan(agent.workspaceRoot, agent.sessionKey);
      const planBlock = planExecutionBlockReason(
        plan.phases ?? [],
        plan.items,
      );
      if (planBlock) {
        deny(
          `Tool "${name}" not dispatched: ${planBlock}. Call update_plan ` +
          'with ordered phases and bounded steps, then continue from the active step.',
        );
      }
    }
  }

  if (ruleDecision === 'allow' && policy.decision === 'ask') {
    policy.decision = 'allow';
    policy.reason = 'cli.permissions allow rule';
  }
  if (policy.mutating && !input.revalidation) {
    agent.policyAudit.push({
      tool: name,
      action: policy.action,
      decision: policy.decision,
      reason: policy.reason,
    });
    traceEvent(
      'policy.decision',
      {
        tool: name,
        action: policy.action,
        decision: policy.decision,
        access_mode: agent.accessMode,
        session_key: agent.sessionKey,
        local: isLocal,
      },
      {
        traceId: input.trace.traceId,
        parentSpanId: input.trace.spanId,
      },
    );
    callbacks.onApproval?.({
      tool: name,
      action: policy.action,
      decision: policy.decision,
      reason: policy.reason,
    });
    // ADR-041 D14 (#4) — log-only: record the approval decision in the trajectory
    // ledger so "the human sees more than the model, and knows the difference".
    // Opt-in, best-effort, never on the model's context path.
    if (getCliKnobs().traceTrajectory === true) {
      try {
        recordTrajectoryEvent(agent.workspaceRoot, agent.sessionKey, {
          event: 'approval',
          label: `${name} → ${policy.decision}`,
          detail: policy.reason,
        });
      } catch { /* trace is advisory — never break a turn */ }
    }
  }

  if (policy.decision === 'deny') {
    deny(`Tool "${name}" denied by execution policy: ${policy.reason}.`);
  }
  if (policy.decision === 'ask' && agent.silent) {
    deny(
      `Tool "${name}" requires approval but this session can't prompt ` +
      `(fail-closed): ${policy.reason}.`,
    );
  }
  if (
    policy.action === 'file_edit' &&
    typeof args?.path === 'string' &&
    args.path
  ) {
    const target = path.resolve(agent.workspaceRoot, args.path);
    const external = externalDirectoryDecision(
      target,
      agent.workspaceRoot,
      knobs.externalDirWrites,
      isPathWithinRoots,
    );
    if (external.decision === 'deny') {
      deny(`Tool "${name}" denied: ${external.reason}.`);
    }
    if (external.decision === 'ask' && agent.silent) {
      deny(
        `Tool "${name}" requires approval (external write) but this session ` +
        `can't prompt: ${external.reason}.`,
      );
    }
  }

  if (isLocal && !registryToolAllowed(name, agent.accessMode)) {
    deny(
      `Tool "${name}" is not permitted in access mode "${agent.accessMode}".`,
    );
  }
}
