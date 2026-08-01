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
import { registryToolAllowed } from '../../tool/registry/registry.js';
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
  requiredSkillActivation: RequiredSkillActivation;
  loadedRequiredSkills: ReadonlySet<string>;
  attemptedRequiredSkills: ReadonlySet<string>;
  /**
   * ADR-027 D3 — per-turn record of unresolvable required skills we have already
   * warned about, so a degraded workflow reports ONCE instead of re-warning on
   * every mutating call. Notification acceptance decays with repetition, so a
   * per-call warning would train the user to ignore it.
   */
  warnedRequiredSkills?: Set<string>;
  trace: { traceId: string; spanId: string };
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

  const knobs = getCliKnobs();
  const ruleDecision = evaluatePermissionRules(
    knobs.permissions,
    name,
    primaryArgText(name, args),
    { workspace: agent.workspaceRoot },
  );
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
    // ADR-027 D3 — an UNRESOLVABLE required workflow degrades to a warning, not
    // a denial. Explicitly disabling a skill (handled above) is user intent and
    // still blocks; failing to load one is an infrastructure problem, and a
    // missing workflow must never be able to deadlock the agent. The turn
    // proceeds without the workflow's guidance, and says so once.
    if (blockedSkills.length > 0) {
      const unresolved = blockedSkills.map((skill) => skill.id);
      const unwarned = input.warnedRequiredSkills
        ? unresolved.filter((id) => !input.warnedRequiredSkills!.has(id))
        : unresolved;
      if (unwarned.length > 0) {
        for (const id of unwarned) input.warnedRequiredSkills?.add(id);
        const attempted = blockedSkills.filter((skill) =>
          input.attemptedRequiredSkills.has(skill.id));
        callbacks.onNotice?.({
          level: 'warn',
          message:
            `Proceeding without required workflow skill(s) ` +
            `${attempted.length === blockedSkills.length
              ? 'the host could not load'
              : 'that are not ready'}: ${unwarned.join(', ')}. ` +
            'Their guidance is unavailable for this turn, so review the result more closely than usual.',
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
    if (planningRequired && phaseGatedMutation) {
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
  if (policy.mutating) {
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
