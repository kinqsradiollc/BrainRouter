import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BenchmarkDataset, BenchmarkQuery, BenchmarkRecord, RankedResult, SystemAdapter } from "../shared/schema.js";

type McpToolResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

function readText(result: McpToolResult): string {
  return (result.content ?? [])
    .map((item) => typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function parseToolJson(result: McpToolResult): unknown {
  const text = readText(result);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function collectMemories(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectMemories);
  const obj = value as Record<string, unknown>;
  const direct = [
    obj.recalledCognitiveMemories,
    obj.memories,
    obj.results,
    obj.records,
  ];
  for (const candidate of direct) {
    if (Array.isArray(candidate)) return candidate.flatMap(collectMemories);
  }
  if (typeof obj.recordId === "string" || typeof obj.id === "string" || typeof obj.content === "string") return [obj];
  return Object.values(obj).flatMap(collectMemories);
}

function recordToMemory(record: BenchmarkRecord, dataset: BenchmarkDataset): Record<string, unknown> {
  return {
    id: record.id,
    content: [
      `BenchmarkRecordId: ${record.id}`,
      record.content,
    ].join("\n"),
    type: "fact",
    priority: 80,
    sceneName: dataset.id,
    sessionKey: record.sessionId ?? dataset.id,
    sessionId: record.sessionId ?? "",
    timestampStr: record.timestamp ?? "",
    timestampStart: record.timestamp ?? "",
    timestampEnd: record.timestamp ?? "",
    metadata: {
      ...(record.metadata ?? {}),
      benchmarkDatasetId: dataset.id,
      benchmarkSource: dataset.source,
    },
    confidence: 0.95,
    status: "active",
    sourceKind: "benchmark",
    verificationStatus: "verified",
  };
}

export class BrainRouterMcpAdapter implements SystemAdapter {
  // Allow distinct system ids per run (e.g. brainrouter-precision vs
  // brainrouter-recall) so a single report can compare BrainRouter configs.
  id = process.env.BRAINROUTER_BENCH_SYSTEM_ID?.trim() || "brainrouter-memory";
  label = process.env.BRAINROUTER_BENCH_SYSTEM_LABEL?.trim() || "BrainRouter Memory";
  kind = "brainrouter" as const;
  private url = process.env.BRAINROUTER_BENCH_MCP_URL;
  private apiKey = process.env.BRAINROUTER_BENCH_API_KEY ?? process.env.BRAINROUTER_API_KEY;
  // MCP requests inherit the SDK's 60s default. A BrainRouter backed by a local
  // LLM (embeddings + relevance judge) can exceed that on import/recall, so make
  // the per-call timeout configurable with a generous default.
  private timeoutMs = Math.max(1000, Number(process.env.BRAINROUTER_BENCH_MCP_TIMEOUT_MS ?? 300000));
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private dataset?: BenchmarkDataset;

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    // Lets the runner mark a config unavailable up front (e.g. its reranker
    // endpoint failed a pre-flight probe) so the report states it explicitly
    // instead of silently benchmarking a degraded fallback.
    const forced = process.env.BRAINROUTER_BENCH_FORCE_UNAVAILABLE?.trim();
    if (forced) return { available: false, reason: forced };
    if (!this.url) return { available: false, reason: "BRAINROUTER_BENCH_MCP_URL is not set" };
    if (!this.apiKey) return { available: false, reason: "BRAINROUTER_BENCH_API_KEY or BRAINROUTER_API_KEY is not set" };
    try {
      await this.ensureClient();
      return { available: true };
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.url || !this.apiKey) throw new Error("BrainRouter MCP URL/API key missing");
    this.client = new Client({ name: "brainrouter-benchmark", version: "0.1.0" }, { capabilities: {} });
    this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      },
    } as any);
    await this.client.connect(this.transport);
    return this.client;
  }

  async setup(dataset: BenchmarkDataset): Promise<void> {
    await this.ensureClient();
    this.dataset = dataset;
  }

  async ingest(records: BenchmarkRecord[]): Promise<void> {
    if (!this.dataset || process.env.BRAINROUTER_BENCH_SKIP_IMPORT === "1") return;
    const client = await this.ensureClient();
    const batchSize = Math.max(1, Number(process.env.BRAINROUTER_BENCH_IMPORT_BATCH_SIZE ?? 500));
    const memories = records.map((record) => recordToMemory(record, this.dataset!));
    for (let offset = 0; offset < memories.length; offset += batchSize) {
      const batch = memories.slice(offset, offset + batchSize);
      const result = await client.callTool({
        name: "memory_import",
        arguments: {
          data: {
            version: 1,
            memories: batch,
            evidence: [],
            operations: [],
          },
        },
      }, undefined, { timeout: this.timeoutMs }) as McpToolResult;
      if (result.isError) throw new Error(readText(result) || "memory_import failed");
    }
  }

  async query(query: BenchmarkQuery, limit: number): Promise<RankedResult[]> {
    const client = await this.ensureClient();
    const result = await client.callTool({
      name: "memory_recall",
      arguments: {
        sessionKey: "brainrouter-benchmark",
        query: query.query,
        filters: {
          scope: "workspace",
        },
      },
    }, undefined, { timeout: this.timeoutMs }) as McpToolResult;
    if (result.isError) throw new Error(readText(result) || "memory_recall failed");

    const parsed = parseToolJson(result);
    const memories = collectMemories(parsed);
    const ranked: RankedResult[] = [];
    const seen = new Set<string>();
    for (const [index, memory] of memories.entries()) {
      const content = String(memory.content ?? memory.text ?? "");
      const explicit = typeof memory.recordId === "string" ? memory.recordId : typeof memory.id === "string" ? memory.id : "";
      const marker = content.match(/BenchmarkRecordId:\s*([^\s]+)/)?.[1];
      const recordId = marker ?? explicit;
      if (!recordId || seen.has(recordId)) continue;
      seen.add(recordId);
      ranked.push({
        recordId,
        score: Number(memory.score ?? memory.finalScore ?? 1 / (index + 1)),
        content,
        metadata: { adapter: this.id, rawRecordId: explicit || undefined },
      });
      if (ranked.length >= limit) break;
    }
    return ranked;
  }

  async teardown(): Promise<void> {
    try {
      await this.transport?.terminateSession();
    } catch {
      // Best-effort MCP session cleanup.
    }
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }
}

export function memoryPeerAdapters(): SystemAdapter[] {
  return [new BrainRouterMcpAdapter()];
}
