import type { RecalledMemory } from "@kinqs/brainrouter-types";
import { estimateTokens } from "./tokens.js";
import { compress, type CompressionStore } from "./router.js";

export interface RecallCompressionConfig {
  enabled: boolean;
  minTokens: number;
  targetKeep: number;
}

export const RECALL_COMPRESSION_DEFAULT: RecallCompressionConfig = {
  enabled: false,
  minTokens: 500,
  targetKeep: 0.2,
};

export const RECALL_COMPRESSION_NOTE =
  "Some recalled memories were compacted; use memory_retrieve with the reference in a marker to recover the full original.";

export function readRecallCompressionConfig(env: NodeJS.ProcessEnv = process.env): RecallCompressionConfig {
  const minTokens = readPositiveInteger(env.BRAINROUTER_COMPRESSION_MIN_TOKENS, RECALL_COMPRESSION_DEFAULT.minTokens);
  const targetKeep = readRatio(env.BRAINROUTER_COMPRESSION_TARGET_KEEP, RECALL_COMPRESSION_DEFAULT.targetKeep);
  return {
    enabled: env.BRAINROUTER_COMPRESSION_ENABLED === "true",
    minTokens,
    targetKeep,
  };
}

export async function applyRecallCompression(
  memories: RecalledMemory[],
  options: {
    userId: string;
    query: string;
    store: CompressionStore;
    config?: RecallCompressionConfig;
  },
): Promise<{ memories: RecalledMemory[]; compressedCount: number }> {
  const config = options.config ?? readRecallCompressionConfig();
  if (!config.enabled) return { memories, compressedCount: 0 };

  let compressedCount = 0;
  const compressedMemories: RecalledMemory[] = [];
  for (const memory of memories) {
    if (estimateTokens(memory.content) <= config.minTokens) {
      compressedMemories.push(memory);
      continue;
    }
    try {
      const result = await compress(memory.content, {
        userId: options.userId,
        store: options.store,
        queryContext: options.query,
        targetKeep: config.targetKeep,
        toolName: "memory_recall",
        // Force the lossy (CCR-backed) branch for recall: the lossless tabular
        // fold returns a CSV-schema blob with no marker, which we'd have to skip
        // (silently losing the saving) and which would also hand the model an
        // unlabeled non-JSON payload in place of a memory. The lossy branch
        // always leaves a `<<ccr:…>>` marker + a memory_retrieve path, so the
        // saving is captured and the original stays fully recoverable.
        preferLossless: false,
      });
      // A hash-less result here means nothing was offloaded (content too small
      // or not an array) — keep the original memory untouched.
      if (!result.hash) {
        compressedMemories.push(memory);
        continue;
      }
      compressedCount += 1;
      compressedMemories.push({ ...memory, content: result.compressed });
    } catch {
      compressedMemories.push(memory);
    }
  }
  return compressedCount === 0
    ? { memories, compressedCount: 0 }
    : { memories: compressedMemories, compressedCount };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readRatio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}
