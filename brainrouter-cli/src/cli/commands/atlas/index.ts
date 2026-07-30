/**
 * ATLAS (0.4.16) — `/atlas` slash command.
 *
 * Builds, shows, or enriches the codebase knowledge graph for the active
 * workspace. `build` is deterministic (scan + symbol extraction + base graph);
 * `enrich` layers LLM understanding on top (per-file summaries + tags,
 * architectural layers, a guided tour) using the configured model. The graph
 * persists per-workspace via the core atlasStore, so the desktop Atlas panel
 * renders the same artifact.
 */
import chalk from "chalk";
import {
  buildBaseGraph,
  saveAtlasGraph,
  readAtlasGraph,
  atlasGraphStats,
  validateAtlasGraph,
  atlasGraphFile,
  atlasWorkspaceTag,
  enrichAtlasGraph,
  carryForwardSummaries,
  type AtlasLlmCaller,
} from "@kinqs/brainrouter-core/atlas";
import { callOpenAI } from "@kinqs/brainrouter-core/agent";
import { resolveCliKnobs } from '@kinqs/brainrouter-core/config';
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import type { CommandContext } from "../_context.js";
import type { McpClientPool } from "@kinqs/brainrouter-core/mcp";

/** Call a brain Atlas tool through the MCP pool, parsing its JSON text result. Null on any failure. */
async function callBrainAtlas(mcpClient: McpClientPool, tool: string, args: Record<string, unknown>): Promise<any | null> {
  try {
    const res = await mcpClient.callTool(tool, args);
    if (!res || res.isError) return null;
    const text = res?.content?.[0]?.text;
    return typeof text === "string" && text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Push the workspace's Atlas graph to the connected brain (REMOTE-BRAIN Phase 3d). */
async function pushAtlasToBrain(mcpClient: McpClientPool, root: string, graph: AtlasGraph): Promise<{ ok: boolean; nodeCount?: number }> {
  const out = await callBrainAtlas(mcpClient, "atlas_put", { workspaceTag: atlasWorkspaceTag(root), graph });
  return out?.ok ? { ok: true, nodeCount: out.nodeCount } : { ok: false };
}

/** Fetch the workspace's Atlas graph from the connected brain, or null when absent. */
async function pullAtlasFromBrain(mcpClient: McpClientPool, root: string): Promise<AtlasGraph | null> {
  const out = await callBrainAtlas(mcpClient, "atlas_get", { workspaceTag: atlasWorkspaceTag(root) });
  return out?.found && out.graph ? (out.graph as AtlasGraph) : null;
}

export async function tryHandleAtlasCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, config, mcpClient } = ctx;
  if (command !== "/atlas" && command !== "/map") return false;

  const sub = (args[0] ?? "").toLowerCase();
  const root = agent.workspaceRoot;
  const remoteBrain = !!resolveCliKnobs(config).brainUrl;

  if (sub === "help") {
    printUsage();
    return true;
  }

  // REMOTE-BRAIN Phase 3d — sync the workspace's Atlas with the connected brain.
  if (sub === "push") {
    const graph = readAtlasGraph(root);
    if (!graph) {
      console.log(chalk.yellow("\nNo atlas to push — build one first with: /atlas\n"));
      return true;
    }
    const res = await pushAtlasToBrain(mcpClient, root, graph);
    console.log(res.ok
      ? chalk.green(`\n✓ Pushed atlas to the brain (${res.nodeCount ?? graph.nodes.length} nodes, tag ${atlasWorkspaceTag(root)}).\n`)
      : chalk.red("\nPush failed — is a BrainRouter brain connected (and atlas tools available)?\n"));
    return true;
  }

  if (sub === "pull") {
    const graph = await pullAtlasFromBrain(mcpClient, root);
    if (!graph) {
      console.log(chalk.yellow("\nNo atlas on the brain for this workspace yet (push one with: /atlas push).\n"));
      return true;
    }
    saveAtlasGraph(root, graph);
    console.log(chalk.green(`\n✓ Pulled atlas from the brain → saved locally.`));
    printSummary(graph, atlasGraphFile(root));
    return true;
  }

  if (sub === "show" || sub === "stats") {
    const graph = readAtlasGraph(root);
    if (!graph) {
      console.log(chalk.yellow("\nNo atlas yet — build one with: /atlas\n"));
      return true;
    }
    printSummary(graph, atlasGraphFile(root));
    return true;
  }

  // default + "build" → (re)build the deterministic base graph
  if (sub === "" || sub === "build" || sub === "rebuild") {
    console.log(chalk.dim("\nScanning workspace and building the codebase atlas…"));
    const started = Date.now();
    let graph;
    try {
      // COST-CACHE — preserve the prior enrichment's summaries across a rebuild so
      // the next `/atlas enrich` only re-pays for files whose structure changed.
      graph = carryForwardSummaries(buildBaseGraph(root), readAtlasGraph(root));
    } catch (e) {
      console.log(chalk.red(`\nAtlas build failed: ${e instanceof Error ? e.message : String(e)}\n`));
      return true;
    }
    const v = validateAtlasGraph(graph);
    if (!v.ok) {
      console.log(chalk.red(`\nAtlas graph failed validation:\n  ${v.errors.slice(0, 5).join("\n  ")}\n`));
      return true;
    }
    saveAtlasGraph(root, graph);
    console.log(chalk.green(`\n✓ Atlas built in ${((Date.now() - started) / 1000).toFixed(1)}s`));
    printSummary(graph, atlasGraphFile(root));
    if (v.warnings.length) console.log(chalk.dim(`  (${v.warnings.length} advisory warning${v.warnings.length === 1 ? "" : "s"})`));
    console.log(chalk.dim("  Open the Atlas panel in the desktop app to explore it visually.\n"));
    // REMOTE-BRAIN Phase 3d — with a remote brain configured, sync the fresh
    // build up so other clients (and the dashboard) can serve it. Best-effort.
    if (remoteBrain) {
      const res = await pushAtlasToBrain(mcpClient, root, graph);
      console.log(res.ok ? chalk.dim("  ↑ synced to the remote brain.\n") : chalk.dim("  (remote brain sync skipped — not reachable)\n"));
    }
    return true;
  }

  // "enrich" → layer LLM understanding on top of the base graph
  if (sub === "enrich") {
    let graph = readAtlasGraph(root);
    if (!graph) {
      console.log(chalk.dim("\nNo atlas yet — building the base graph first…"));
      try {
        graph = buildBaseGraph(root);
        saveAtlasGraph(root, graph);
      } catch (e) {
        console.log(chalk.red(`\nAtlas build failed: ${e instanceof Error ? e.message : String(e)}\n`));
        return true;
      }
    }

    const llm = config.llm;
    if (!llm || (!llm.apiKey && (llm.provider ?? "openai") === "openai")) {
      console.log(chalk.yellow("\nNo model configured — set a provider/model (and API key) before enriching.\n"));
      return true;
    }

    const caller: AtlasLlmCaller = async ({ system, user, signal, tool }) => {
      // STRUCTURED OUTPUT — when enrich asks for a tool, force that function so
      // the result is the schema-shaped tool-call arguments (consistent across
      // models), and read them back. The prompt still carries the JSON
      // instruction, so a model that answers in content still parses.
      const tools = tool ? [{ name: tool.name, description: tool.description ?? "", inputSchema: tool.parameters }] : [];
      const resp = await callOpenAI(
        llm,
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools,
        { effort: "low", signal, ...(tool ? { tool_choice: { type: "function" as const, function: { name: tool.name } } } : {}) },
      );
      const args = (resp as { tool_calls?: Array<{ function?: { arguments?: string } }> })?.tool_calls?.[0]?.function?.arguments;
      if (typeof args === "string" && args.trim()) return args;
      return (resp?.content as string) ?? "";
    };

    console.log(chalk.dim(`\nEnriching atlas with ${llm.model} — summaries, layers, and a guided tour…`));
    const started = Date.now();
    let lastPhase = "";
    let res;
    try {
      res = await enrichAtlasGraph(graph, caller, {
        onProgress: ({ phase, done, total }) => {
          if (phase !== lastPhase) {
            if (lastPhase) process.stdout.write("\n");
            lastPhase = phase;
          }
          process.stdout.write(`\r  ${phase}: ${done}/${total}   `);
        },
      });
    } catch (e) {
      console.log(chalk.red(`\nAtlas enrichment failed: ${e instanceof Error ? e.message : String(e)}\n`));
      return true;
    }
    if (lastPhase) process.stdout.write("\n");

    saveAtlasGraph(root, res.graph);
    console.log(
      chalk.green(
        `\n✓ Enriched in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
          `${res.summarized} summaries · ${res.layers} layers · ${res.tourSteps} tour steps`,
      ),
    );
    if (res.batchesFailed) {
      console.log(chalk.dim(`  (${res.batchesFailed} batch${res.batchesFailed === 1 ? "" : "es"} skipped — unparseable model output)`));
    }
    printSummary(res.graph, atlasGraphFile(root));
    // REMOTE-BRAIN Phase 3d — sync the enriched graph to the remote brain.
    if (remoteBrain) {
      const pushed = await pushAtlasToBrain(mcpClient, root, res.graph);
      console.log(pushed.ok ? chalk.dim("  ↑ synced to the remote brain.\n") : chalk.dim("  (remote brain sync skipped — not reachable)\n"));
    }
    return true;
  }

  console.log(chalk.red(`\nUnknown atlas subcommand: ${sub}`));
  printUsage();
  return true;
}

function printSummary(graph: ReturnType<typeof readAtlasGraph> & object, file: string): void {
  const s = atlasGraphStats(graph as Parameters<typeof atlasGraphStats>[0]);
  const g = graph as NonNullable<ReturnType<typeof readAtlasGraph>>;
  console.log(chalk.bold(`\n${g.project.name}`));
  if (g.project.description) console.log(chalk.dim(`  ${g.project.description}`));
  const langs = g.project.languages.slice(0, 6).join(", ");
  if (langs) console.log(`  ${chalk.cyan("languages")}  ${langs}`);
  if (g.project.frameworks?.length) console.log(`  ${chalk.cyan("frameworks")} ${g.project.frameworks.join(", ")}`);
  console.log(
    `  ${chalk.cyan("graph")}      ${s.files} files · ${s.functions} functions · ${s.classes} classes · ${s.edges} edges` +
      (s.enriched ? chalk.green("  (enriched)") : chalk.dim("  (structural)")),
  );
  console.log(chalk.dim(`  saved to ${file}\n`));
}

function printUsage(): void {
  console.log(chalk.bold("\nAtlas — codebase knowledge graph"));
  console.log("  /atlas            Build (or rebuild) the atlas for this workspace");
  console.log("  /atlas enrich     Add LLM summaries, layers, and a guided tour");
  console.log("  /atlas show       Show the current atlas summary");
  console.log("  /atlas push       Upload this workspace's atlas to the connected brain");
  console.log("  /atlas pull       Download this workspace's atlas from the brain");
  console.log(chalk.dim("\n  With a remote brain (cli.brainUrl), build/enrich auto-sync up."));
  console.log(chalk.dim("  Explore it visually in the desktop app's Atlas panel.\n"));
}
