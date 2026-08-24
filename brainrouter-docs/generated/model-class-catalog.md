<!-- GENERATED FILE — do not edit by hand.
     Source: packages/types/src/memory/agents.ts (BRAIN_AGENT_MODEL_CLASSES)
             + brainrouter/src/memory/agents/registry.ts (listBrainAgents).
     Regenerate: REGEN_CATALOG=1 npx vitest run src/memory/agents/modelClassCatalog.test.ts
     Drift-checked by brainrouter/src/memory/agents/modelClassCatalog.test.ts (ADR-046 S6). -->

# BrainRouter model-class catalog

5 model classes the brain agents route on, covering 16 built-in agent(s). The class drives provider routing, the tier ladder, and cache-stats grouping; `none` is a heuristic agent that does no LLM work.

| Model class | Agents | Members |
|-------------|--------|---------|
| `extraction` | 2 | `cognitive_extractor`, `graph_extractor` |
| `synthesis` | 3 | `focus_distiller`, `identity_distiller`, `tree_digest` |
| `judge` | 3 | `contradiction_checker`, `focus_shift_judge`, `memory_deduper` |
| `embedding` | 0 | — |
| `none` | 8 | `benchmark_eval`, `blackboard_reconciler`, `connector_sync`, `source_chunker`, `tree_sealer`, `vault_exporter`, `vulnerability_scan`, `vulnerability_sync` |
