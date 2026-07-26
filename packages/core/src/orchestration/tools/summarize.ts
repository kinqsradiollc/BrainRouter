import { formatSessionSummary, type ChildSessionRecord } from '../session/orchestrator.js';
import { parseChildOutput } from '../roles/outputContracts.js';
import type { ParsedOutput } from '../roles/outputContracts.js';

export function summarize(record: ChildSessionRecord, includeOutput = false): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: record.id,
    role: record.role,
    status: record.status,
    access: record.access,
    label: record.label,
    // MAS-P3: surface the child's ownership boundary so the parent can see
    // which files each child was allowed to touch when synthesizing.
    ownership: record.parentContext?.ownership ?? null,
    // MAS-P4-T4: follow-up agents auto-chained after this worker, if any.
    followUps: record.autoChainFollowups ?? undefined,
    // MAS-P4-T3: per-child accounting (tokens, calls, offloaded chars, wall-clock).
    usage: record.usage ?? undefined,
    workspaceRoot: record.childWorkspaceRoot ?? undefined,
    workdir: record.childLaunchCwd ?? undefined,
    isolation: record.childWorkspaceIsolation ?? undefined,
    isolationNotice: record.childWorkspaceNotice ?? undefined,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    summary: formatSessionSummary(record),
  };
  // CODEX-WORKTREE-MERGEBACK — surface the child's isolated-worktree changes so the
  // parent can see + recover them. With merge-back the edits land in the parent tree
  // (`applied: true`); otherwise the full patch waits at `patchPath` for `git apply`.
  if (record.worktreeChangedFiles != null || record.worktreePatchPath || record.worktreeApplyError) {
    base.worktree = {
      changedFiles: record.worktreeChangedFiles ?? undefined,
      applied: record.worktreeApplied ?? undefined,
      patchPath: record.worktreePatchPath ?? undefined,
      applyError: record.worktreeApplyError ?? undefined,
    };
  }
  if (includeOutput) {
    if (record.finalOutput) base.finalOutput = record.finalOutput;
    if (record.error) base.error = record.error;
    if (record.filesRead?.length) base.filesRead = record.filesRead; // MAS-READMANIFEST
    if (record.worktreeDiff) base.worktreeDiff = record.worktreeDiff;
    // MAS-P3-P3.2: when the role has an output contract, surface the parsed
    // fields (or the unparsed/missing signal) so `wait_agent --json` /
    // `wait_agents --json` callers get structured output, not just prose.
    const parsed = parseChildOutput(record.role, record.finalOutput);
    if (parsed) {
      base.contract = parsed;
      base.result = delegatedResult(parsed);
    }
    if (record.delegatedTaskPacket) {
      base.taskPacket = {
        schemaVersion: record.delegatedTaskPacket.schemaVersion,
        persona: record.delegatedTaskPacket.persona,
        orchestration: record.delegatedTaskPacket.orchestration,
        capabilities: record.delegatedTaskPacket.capabilities.active,
        toolPolicyCeiling: {
          accessMode: record.delegatedTaskPacket.toolPolicyCeiling.accessMode,
          localToolCount: record.delegatedTaskPacket.toolPolicyCeiling.localTools.length,
          mcpToolCount: record.delegatedTaskPacket.toolPolicyCeiling.mcpTools.length,
        },
        budgets: record.delegatedTaskPacket.budgets,
      };
    }
  }
  return base;
}

function delegatedResult(parsed: ParsedOutput): Record<string, unknown> {
  const pick = (...keys: string[]): string[] =>
    keys.map((key) => parsed.fields[key]).filter((value): value is string => Boolean(value));
  return {
    conclusions: pick('headline', 'recommendation'),
    evidence: pick('facts', 'filesRead', 'commands', 'findings', 'tradeoffs'),
    changes: pick('filesChanged', 'summary', 'firstSlice'),
    verification: pick('passFail', 'commands', 'testsSuggested'),
    unresolved: pick('openQuestions', 'risks', 'outOfScope', 'nextProbe'),
    failures: [
      ...pick('failures'),
      ...(parsed.missing.length > 0
        ? [`Missing required output fields: ${parsed.missing.join(', ')}`]
        : []),
    ],
  };
}
