// Record the user+assistant exchange into BrainRouter memory, honouring the
// requested capture mode (off / sensory / full).

import { memoryEngine } from "../../../memory/engine.js";

/**
 * Record the exchange into BrainRouter memory.
 *
 *   mode === "sensory"  → cheap: just store sensory rows. No upstream LLM
 *                          call. This is the default for the web chat so a
 *                          single user message does NOT cascade into
 *                          extraction + contradiction + persona + graph
 *                          requests against the upstream model.
 *   mode === "full"     → full pipeline: cognitive extraction, contradiction
 *                          detection, persona distillation, graph build.
 *                          Multiple upstream LLM calls per turn. Use this
 *                          when the user explicitly asks for deep memory.
 *   mode === "off"      → no-op.
 */
async function captureTurn(
  userId: string,
  sessionKey: string,
  userText: string,
  assistantText: string,
  activeSkill: string | undefined,
  mode: "off" | "sensory" | "full",
): Promise<void> {
  if (mode === "off") return;
  if (!userText || !assistantText) return;
  try {
    if (mode === "sensory") {
      memoryEngine.capturePassiveL0({ userId, sessionKey, role: "user", content: userText, skillTag: activeSkill });
      memoryEngine.capturePassiveL0({ userId, sessionKey, role: "assistant", content: assistantText, skillTag: activeSkill });
      return;
    }
    await memoryEngine.capture({
      userId,
      sessionKey,
      messages: [
        { role: "user", content: userText, timestamp: Date.now() },
        { role: "assistant", content: assistantText, timestamp: Date.now() },
      ],
      activeSkill,
    });
  } catch (err) {
    console.error("[BrainRouter:/v1] capture failed:", err);
  }
}

export { captureTurn };
