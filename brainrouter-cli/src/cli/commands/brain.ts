/**
 * BRAIN-P1-T5 (0.4.1) — `/brain` slash commands.
 *
 * Observation surface over the brain-side job queue (BRAIN-P1). The CLI
 * is a consumer of brain state, never the authority — these commands
 * only read/observe via the MCP tools shipped in BRAIN-P1-T4:
 *
 *   /brain            → alias for /brain agents
 *   /brain agents     → memory_agent_status: per-agent last status,
 *                       24h success rate, pending count
 *   /brain run <id>   → memory_agent_run: manually enqueue an agent
 *   /brain retry <id> → memory_job_retry: re-arm a failed/cancelled job
 *
 * `/brain jobs` (an individual-job listing) waits on a job-list tool —
 * the status view's pending counts cover the common "is anything
 * stuck?" question for now.
 */

import chalk from 'chalk';
import { callMcpTool } from '../../runtime/mcpUtils.js';
import type { CommandContext } from './_context.js';

interface BrainAgentStatusRow {
  id: string;
  description: string;
  modelClass: string;
  lastJobStatus: string;
  lastJobCompletedAt: string | null;
  successRate24h: number | null;
  pendingJobs: number;
}

function ageLabel(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h ago`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d ago`;
}

function colorStatus(status: string): string {
  switch (status) {
    case 'done':
      return chalk.green(status);
    case 'running':
      return chalk.cyan(status);
    case 'pending':
      return chalk.yellow(status);
    case 'failed':
      return chalk.red(status);
    case 'cancelled':
      return chalk.gray(status);
    default:
      return chalk.gray(status); // 'idle'
  }
}

async function renderAgents(ctx: CommandContext): Promise<void> {
  const res = await callMcpTool<{ agents: BrainAgentStatusRow[] }>(
    ctx.mcpClient,
    'memory_agent_status',
    {},
  );
  if (res.isError) {
    console.log(chalk.red(`\n/brain agents failed: ${res.text || '(no message)'}`));
    console.log(chalk.gray('Is the MCP server on 0.4.1+? memory_agent_status ships in BRAIN-P1.\n'));
    return;
  }
  const agents = res.parsed?.agents ?? [];
  if (agents.length === 0) {
    console.log(chalk.yellow('\nNo brain agents reported.\n'));
    return;
  }
  console.log(chalk.bold('\nBrain agents'));
  const idWidth = Math.max(...agents.map((a) => a.id.length));
  for (const a of agents) {
    const rate = a.successRate24h == null ? chalk.gray('—') : `${Math.round(a.successRate24h * 100)}%`;
    const pending = a.pendingJobs > 0 ? chalk.yellow(`${a.pendingJobs} pending`) : chalk.gray('0 pending');
    console.log(
      `  ${chalk.cyan(a.id.padEnd(idWidth))}  ${chalk.gray(a.modelClass.padEnd(10))}  ` +
        `last: ${colorStatus(a.lastJobStatus)} ${chalk.gray(`(${ageLabel(a.lastJobCompletedAt)})`)}  ` +
        `24h: ${rate}  ${pending}`,
    );
  }
  console.log(chalk.gray('\n  Jobs accrue as the brain captures conversation. /brain retry <jobId> re-arms a failed one.\n'));
}

export async function tryHandleBrainCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, mcpClient } = ctx;
  if (command !== '/brain') return false;

  const sub = (args[0] ?? 'agents').toLowerCase();

  switch (sub) {
    case 'agents':
    case '': {
      await renderAgents(ctx);
      return true;
    }
    case 'run': {
      const agentId = args[1];
      if (!agentId) {
        console.log(chalk.yellow('\nUsage: /brain run <agentId>   (e.g. /brain run identity_distiller)\n'));
        return true;
      }
      const res = await callMcpTool<{ jobId: string; status: string; deduped: boolean }>(
        mcpClient,
        'memory_agent_run',
        { agentId, input: {} },
      );
      if (res.isError) {
        console.log(chalk.red(`\nmemory_agent_run failed: ${res.text || '(no message)'}\n`));
        return true;
      }
      const r = res.parsed;
      if (r?.deduped) {
        console.log(chalk.gray(`\nAlready in flight — job ${r.jobId} (${r.status}).\n`));
      } else {
        console.log(chalk.green(`\nQueued ${agentId} → job ${r?.jobId} (${r?.status}).\n`));
      }
      return true;
    }
    case 'retry': {
      const jobId = args[1];
      if (!jobId) {
        console.log(chalk.yellow('\nUsage: /brain retry <jobId>\n'));
        return true;
      }
      const res = await callMcpTool<{ status: string }>(mcpClient, 'memory_job_retry', { jobId });
      if (res.isError) {
        console.log(chalk.red(`\nmemory_job_retry failed: ${res.text || '(no message)'}\n`));
        return true;
      }
      console.log(chalk.green(`\nJob ${jobId} → ${res.parsed?.status}.\n`));
      return true;
    }
    case 'why': {
      // MAS-P6-T2 — provenance trail for a memory record. Read-only.
      const memoryId = args[1];
      if (!memoryId) {
        console.log(chalk.yellow('\nUsage: /brain why <memoryId>\n'));
        return true;
      }
      const res = await callMcpTool<any>(mcpClient, 'memory_provenance', { memoryId });
      if (res.isError) {
        console.log(chalk.red(`\nmemory_provenance failed: ${res.text || '(no message)'}\n`));
        return true;
      }
      const p = res.parsed;
      if (!p?.found) {
        console.log(chalk.yellow(`\nNo memory record found for "${memoryId}".\n`));
        return true;
      }
      console.log(chalk.bold(`\nProvenance — ${chalk.cyan(p.recordId)}`));
      console.log(`  ${chalk.gray('type:')} ${p.type ?? '?'}   ${chalk.gray('status:')} ${p.active ? chalk.green('active') : chalk.gray(p.status ?? '?')}`);
      if (p.sourceKind) console.log(`  ${chalk.gray('source:')} ${p.sourceKind}`);
      if (p.verificationStatus) console.log(`  ${chalk.gray('verification:')} ${p.verificationStatus}`);
      console.log(`  ${chalk.gray('confidence:')} ${p.confidence ?? '?'}   ${chalk.gray('cited:')} ${p.citationCount ?? 0}×   ${chalk.gray('created:')} ${p.createdTime ?? '?'}`);
      if (p.contentPreview) console.log(`  ${chalk.gray('content:')} ${p.contentPreview}`);
      if (Array.isArray(p.evidence) && p.evidence.length) {
        console.log(chalk.gray('  evidence:'));
        for (const e of p.evidence) console.log(`    - ${e.kind}: ${e.ref}`);
      } else {
        console.log(chalk.gray('  evidence: (none)'));
      }
      if (p.supersededBy) {
        console.log(chalk.yellow(`  superseded by ${p.supersededBy.recordId}: ${p.supersededBy.preview}`));
      }
      console.log();
      return true;
    }
    default: {
      console.log(chalk.yellow(`\nUnknown /brain subcommand: ${sub}`));
      console.log(chalk.gray('  /brain agents · /brain run <agentId> · /brain retry <jobId> · /brain why <memoryId>\n'));
      return true;
    }
  }
}
