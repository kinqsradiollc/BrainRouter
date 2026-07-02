// Shared wire-format types + upstream endpoint for the OpenAI-compatible
// /v1/chat/completions endpoint.

const DEFAULT_UPSTREAM_ENDPOINT =
  process.env.BRAINROUTER_LLM_ENDPOINT ?? "https://api.openai.com/v1/chat/completions";

interface IncomingMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }>;
  name?: string;
}

interface IncomingBody {
  model?: string;
  messages: IncomingMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** BrainRouter-specific extensions. Optional; the endpoint stays OpenAI-shape if these are omitted. */
  brainrouter?: {
    sessionKey?: string;
    workspacePath?: string;
    activeSkill?: string;
    /** When false, the briefing system message is not injected. Useful for raw passthrough tests. */
    inject_briefing?: boolean;
    /**
     * Capture mode for the user+assistant exchange:
     *   "off"     — do nothing. Stateless chat.
     *   "sensory" — (default) write a sensory row only. No upstream LLM call.
     *               Backlogged extraction can be triggered explicitly later.
     *   "full"    — full memoryEngine.capture(): may invoke cognitive
     *               extraction, contradiction detection, persona distillation,
     *               and graph extraction. EACH of those can fire its own LLM
     *               call, so a single user turn can produce many upstream
     *               requests. Opt-in only — that's what was being reported as
     *               "requests keep coming nonstop."
     * Legacy boolean field `capture_turn` is honoured for back-compat:
     *   capture_turn === false maps to "off".
     */
    capture_mode?: "off" | "sensory" | "full";
    capture_turn?: boolean;
  };
}

export { DEFAULT_UPSTREAM_ENDPOINT };
export type { IncomingMessage, IncomingBody };
