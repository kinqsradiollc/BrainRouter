import { execSync } from 'node:child_process';
import { readPreferences } from '@kinqs/brainrouter-core/session';
import { resolveTierLadder, currentTier } from '@kinqs/brainrouter-core/provider';
import { isKnownSegment, renderSegments } from '../../view/statusline.js';
import type { RunChatContext } from './context.js';

/**
 * Footer + terminal-title refreshers. Both derive model · session · branch
 * from current agent state and prefs; `refreshFooter` is re-run after each
 * turn so the bar reflects post-turn model swaps, branch changes, etc.
 */
export function installFooter(ctx: RunChatContext): void {
  const { agent } = ctx;

  // Footer refresh — derives model · session · branch from current agent
  // state and prefs. Re-run after each turn so the bar reflects post-turn
  // model swaps, branch changes, etc.
  ctx.refreshFooter = () => {
    if (!ctx.controller) return;
    const prefs = readPreferences(agent.workspaceRoot);
    const requested = prefs.statusline.split(',').map((s) => s.trim()).filter(Boolean);
    const segments = requested.filter(isKnownSegment).filter((segment) => segment !== 'effort');
    // FOOTER-TELEMETRY — precompute the model tier (only when the user opted the
    // segment in, to avoid the ladder lookup every refresh).
    let tier: string | null = null;
    if (segments.includes('tier')) {
      try {
        const provider = (agent.getLlmConfig?.()?.provider ?? 'openai').toLowerCase();
        tier = currentTier(agent.getModel(), resolveTierLadder({ provider }));
      } catch { tier = null; }
    }
    const rendered = renderSegments(segments, {
      workspaceRoot: agent.workspaceRoot,
      sessionKey: agent.sessionKey,
      accessMode: agent.getAccessMode(),
      model: agent.getModel(),
      lastTurnUsage: agent.lastTurnUsage,
      tier,
      repairTotals: agent.getRepairTotals?.(),
      offloadTotals: agent.getOffloadTotals?.(),
      prDetector: () => ctx.detectGitHubPR(agent.workspaceRoot),
    });
    let branch: string | undefined;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: agent.workspaceRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
    } catch { /* not a git repo */ }
    ctx.controller.setFooter({
      model: agent.getModel(),
      session: agent.sessionKey,
      branch,
      effort: prefs.effort,
      accessMode: agent.getAccessMode() as 'read' | 'write' | 'shell',
      rightExtra: rendered.length > 0 ? rendered.join(' · ') : undefined,
      // Surface background-child count so the footer says "· N working"
      // even after the parent turn yields back to idle. Without this the
      // user had to run /where to discover that delegate_agent / fire-
      // and-forget children were still alive in the session store.
      runningChildren: ctx.getRunningChildCount(),
    });
    ctx.refreshTerminalTitle();
  };

  ctx.refreshTerminalTitle = () => {
    try {
      const prefs = readPreferences(agent.workspaceRoot);
      const cfg = prefs.terminalTitle ?? 'model,session';
      if (cfg.toLowerCase() === 'off') return;
      const segs = cfg.split(',').map((s) => s.trim()).filter(Boolean);
      const parts: string[] = [];
      for (const seg of segs) {
        if (seg === 'model') parts.push(agent.getModel());
        else if (seg === 'session') parts.push(agent.sessionKey);
        else if (seg === 'mode') parts.push(agent.getAccessMode());
        else if (seg === 'branch') {
          try {
            parts.push(execSync('git rev-parse --abbrev-ref HEAD', {
              cwd: agent.workspaceRoot,
              stdio: ['ignore', 'pipe', 'ignore'],
            }).toString().trim());
          } catch { /* not a git repo */ }
        }
      }
      if (parts.length === 0) return;
      const awaitingCount = (ctx.pendingContinuation ? 1 : 0) + ctx.getRunningChildCount();
      const prefix = awaitingCount > 0 ? `(${awaitingCount}) ` : '';
      process.stdout.write(`\x1b]0;${prefix}brainrouter · ${parts.join(' · ')}\x07`);
    } catch { /* terminal doesn't support OSC titles */ }
  };
}
