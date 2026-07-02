import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { LLMRunner } from "@kinqs/brainrouter-types";
import type { EmbeddingService } from "../store/embedding.js";

/**
 * Shared state + construction for the capture pipeline. Split across sibling
 * modules by concern (persistence → extraction → capture entry) via a linear
 * class chain so every method body stays byte-identical to the original god
 * file while retaining access to `this` state. Fields are `protected` so the
 * concern subclasses can reach them; nothing here is on the public surface.
 */
export class CaptureBase {
  constructor(
    protected store: IMemoryStore,
    protected llmRunner: LLMRunner,
    protected embeddingService: EmbeddingService,
    protected extractEveryNTurns: number = 3
  ) {}

  /**
   * MEM-NONBLOCK — per-(userId,sessionKey) in-flight guard. Cognitive extraction
   * is dispatched in the BACKGROUND (capture replies immediately), so two rapid
   * captures for the same session must not both pull the same unextracted
   * sensory window and double-extract. While an extraction is running for a key,
   * later captures skip the trigger (the in-flight run, the every-N threshold,
   * and the extraction sweeper all re-cover the backlog).
   */
  protected readonly extractionInFlight = new Set<string>();
}
