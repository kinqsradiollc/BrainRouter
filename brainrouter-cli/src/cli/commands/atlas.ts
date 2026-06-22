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
  enrichAtlasGraph,
  type AtlasLlmCaller,
} from "@kinqs/brainrouter-core/dist/atlas/index.js";
import { callOpenAI } from "@kinqs/brainrouter-core/dist/agent/agent.js";
import type { CommandContext } from "./_context.js";

export async function tryHandleAtlasCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, config } = ctx;
  if (command !== "/atlas" && command !== "/map") return false;

  const sub = (args[0] ?? "").toLowerCase();
  const root = agent.workspaceRoot;

  if (sub === "help") {
    printUsage();
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
      graph = buildBaseGraph(root);
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

    const caller: AtlasLlmCaller = async ({ system, user, signal }) => {
      const resp = await callOpenAI(
        llm,
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        [],
        { effort: "low", signal },
      );
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
  console.log(chalk.dim("\n  Explore it visually in the desktop app's Atlas panel.\n"));
}
