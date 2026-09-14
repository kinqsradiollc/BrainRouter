/**
 * ADR-046 S6 — the model-class catalog is generated from code, not hand-kept.
 *
 * The remaining ADR-046 catalog. The other harvested catalogs (command, tool,
 * capability) turned a code-defined set into a doc that fails the build when it
 * drifts; the model classes were the last set still living only as a type-only
 * union. `BRAIN_AGENT_MODEL_CLASSES` (packages/types) is now the runtime source of
 * that set — the `BrainAgentModelClass` type derives from it — and this test
 * harvests it together with the live brain-agent registry into the model-class →
 * agents map. It regenerates `brainrouter-docs/generated/model-class-catalog.md`
 * and asserts the committed copy is byte-identical, so adding/removing a class or
 * an agent that doesn't refresh the doc fails CI. Regenerate with `REGEN_CATALOG=1`.
 *
 * (Personas and file-based triggers are deliberately NOT catalogued here: they are
 * runtime/user-defined sets, not code-defined ones, so a "generated from code"
 * catalog would be empty or misleading for them — see ADR-046 §S6.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRAIN_AGENT_MODEL_CLASSES } from "@kinqs/brainrouter-types";
import { listBrainAgents } from "./registry.js";

const DOC_PATH = fileURLToPath(
  new URL("../../../../brainrouter-docs/generated/model-class-catalog.md", import.meta.url),
);

/** The model-class → agent-ids map, harvested from the live registry. */
function modelClassCatalog(): Array<{ modelClass: string; agentIds: string[] }> {
  const agents = listBrainAgents();
  return BRAIN_AGENT_MODEL_CLASSES.map((modelClass) => ({
    modelClass,
    agentIds: agents
      .filter((agent) => agent.modelClass === modelClass)
      .map((agent) => agent.id)
      .sort(),
  }));
}

function buildModelClassCatalogMarkdown(): string {
  const catalog = modelClassCatalog();
  const totalAgents = catalog.reduce((n, row) => n + row.agentIds.length, 0);
  const rows = catalog.map((row) =>
    `| \`${row.modelClass}\` | ${row.agentIds.length} | ${
      row.agentIds.length ? row.agentIds.map((id) => `\`${id}\``).join(", ") : "—"
    } |`,
  );
  return [
    "<!-- GENERATED FILE — do not edit by hand.",
    "     Source: packages/types/src/memory/agents.ts (BRAIN_AGENT_MODEL_CLASSES)",
    "             + brainrouter/src/memory/agents/registry.ts (listBrainAgents).",
    "     Regenerate: REGEN_CATALOG=1 npx vitest run src/memory/agents/modelClassCatalog.test.ts",
    "     Drift-checked by brainrouter/src/memory/agents/modelClassCatalog.test.ts (ADR-046 S6). -->",
    "",
    "# BrainRouter model-class catalog",
    "",
    `${BRAIN_AGENT_MODEL_CLASSES.length} model classes the brain agents route on, `
      + `covering ${totalAgents} built-in agent(s). The class drives provider routing, `
      + "the tier ladder, and cache-stats grouping; `none` is a heuristic agent that does no LLM work.",
    "",
    "| Model class | Agents | Members |",
    "|-------------|--------|---------|",
    ...rows,
    "",
  ].join("\n");
}

describe("ADR-046 S6 model-class catalog", () => {
  it("the generated model-class catalog is in sync with source (drift check)", () => {
    const generated = buildModelClassCatalogMarkdown();
    if (process.env.REGEN_CATALOG === "1") {
      writeFileSync(DOC_PATH, generated, "utf8");
      return;
    }
    let committed: string;
    try {
      committed = readFileSync(DOC_PATH, "utf8");
    } catch {
      throw new Error(`generated catalog missing at ${DOC_PATH} — run REGEN_CATALOG=1 to create it`);
    }
    expect(generated).toBe(committed);
  });

  it("every registered brain agent declares a known model class (parity)", () => {
    // The type guarantees this at compile time; asserting it at runtime keeps the
    // catalog honest if the registry is ever populated from a looser source.
    const known = new Set<string>(BRAIN_AGENT_MODEL_CLASSES);
    for (const agent of listBrainAgents()) {
      expect(known.has(agent.modelClass), `${agent.id} has unknown class ${agent.modelClass}`).toBe(true);
    }
  });

  it("every model class appears in the catalog exactly once, in declared order", () => {
    const catalog = modelClassCatalog();
    expect(catalog.map((row) => row.modelClass)).toEqual([...BRAIN_AGENT_MODEL_CLASSES]);
  });
});
