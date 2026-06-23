import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { LLMRunner, CognitiveRecord, GraphNode, GraphEdge } from "@kinqs/brainrouter-types";
import { GRAPH_EXTRACTION_SYSTEM_PROMPT, formatGraphExtractionPrompt } from "../prompts/graph-extraction.js";
import { extractJsonValue } from "../util/llm-json.js";
import crypto from "node:crypto";

/**
 * Graph Construction Pipeline
 * Extracts entities and relationships from Cognitive records to update the Knowledge Graph.
 */
export async function buildGraphFromCognitive(params: {
  record: CognitiveRecord;
  store: IMemoryStore;
  llmRunner: LLMRunner;
}) {
  const { record, store, llmRunner } = params;

  // Gate execution with env flag (default is true)
  if (process.env.BRAINROUTER_GRAPH_ENABLED === "false") {
    return;
  }

  // Skip graph extraction if memory is invalidated
  if (record.invalidAt) return;

  const _parsedTimeout = parseInt(process.env.BRAINROUTER_GRAPH_TIMEOUT_MS || "", 10);
  const timeoutMs = isNaN(_parsedTimeout) ? 120000 : _parsedTimeout;

  try {
    const rawExtraction = await llmRunner.run({
      prompt: formatGraphExtractionPrompt(record.content),
      systemPrompt: GRAPH_EXTRACTION_SYSTEM_PROMPT,
      taskId: `graph-extraction-${record.id}`,
      timeoutMs,
      // STRUCTURED OUTPUT — force the {entities, relations} graph through a
      // schema'd tool call (consistent across models; see modelRunner.ts). Loose
      // item schemas — the prompt still defines each entity/relation's fields.
      tool: {
        name: "emit_graph",
        description: "Return the entities and relations extracted from the memory, shaped exactly as the prompt describes.",
        parameters: {
          type: "object",
          properties: {
            entities: { type: "array", items: { type: "object" } },
            relations: { type: "array", items: { type: "object" } },
          },
          required: ["entities"],
          additionalProperties: true,
        },
      },
    });

    // Robust parse: tolerates leaked role tokens, prose, fences, trailing commas
    // and bad backslash escapes (see llm-json.ts) instead of a greedy regex.
    const data: any = extractJsonValue(rawExtraction, { kind: "object" });
    if (!data || !Array.isArray(data.entities)) return;

    const entityMap = new Map<string, string>(); // name -> node.id

    // 1. Process and upsert nodes
    for (const ent of data.entities) {
      const entityName = String(ent.entity || "").trim();
      const entityType = String(ent.type || "concept").trim();
      const confidence = typeof ent.confidence === "number" ? ent.confidence : 1.0;

      if (!entityName) continue;

      // Check if node already exists to get its ID, otherwise create a new one
      const existingNode = await store.getGraphNodeByEntity(record.userId, entityName);
      const nodeId = existingNode?.id ?? `gn_${crypto.randomBytes(6).toString("hex")}`;
      entityMap.set(entityName.toLowerCase(), nodeId);

      const node: GraphNode = {
        id: nodeId,
        userId: record.userId,
        entity: entityName,
        entityType,
        skillTag: record.skillTag || "",
        confidence,
        sourceRecordId: record.id,
        createdTime: record.createdTime || new Date().toISOString()
      };

      await store.upsertGraphNode(node);
    }

    // 2. Process and upsert edges
    if (Array.isArray(data.relations)) {
      for (const rel of data.relations) {
        const fromName = String(rel.from || "").trim();
        const toName = String(rel.to || "").trim();
        const relation = String(rel.relation || "relates_to").trim();
        const confidence = typeof rel.confidence === "number" ? rel.confidence : 1.0;

        if (!fromName || !toName) continue;

        const fromNodeId = entityMap.get(fromName.toLowerCase());
        const toNodeId = entityMap.get(toName.toLowerCase());

        if (!fromNodeId || !toNodeId) {
          // Skip edges where one endpoint wasn't extracted (LLM mentioned it in relations but not in entities — common with the 5-entity cap)
          continue;
        }

        const edge: GraphEdge = {
          id: `ge_${crypto.randomBytes(6).toString("hex")}`,
          userId: record.userId,
          fromNodeId,
          toNodeId,
          relation,
          skillTag: record.skillTag || "",
          confidence,
          sourceRecordId: record.id,
          createdTime: record.createdTime || new Date().toISOString()
        };

        await store.upsertGraphEdge(edge);
      }
    }
  } catch (err) {
    console.error(`[BrainRouter] Graph extraction failed for record ${record.id}:`, (err as Error).message);
  }
}
