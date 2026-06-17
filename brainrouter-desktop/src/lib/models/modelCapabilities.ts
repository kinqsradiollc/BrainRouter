/**
 * §13 PROVIDER CAPABILITY UX — derive a model's capabilities from its id.
 *
 * Endpoints rarely return structured capability metadata, so this is a pure,
 * heuristic mapping from the model id (family/suffix patterns) to the flags the
 * UI surfaces: text / reasoning / vision / audio / tool-use + an approximate
 * context window and an optional cost note. Heuristic by design — it's a hint
 * next to each model, not a contract — and unit-tested so the patterns are
 * pinned. No image-generation flag (out of scope for this release).
 */

export interface ModelCapabilities {
  text: boolean;
  reasoning: boolean;
  vision: boolean;
  audio: boolean;
  toolUse: boolean;
  /** Approximate context window in thousands of tokens, when known. */
  contextK?: number;
  /** Short free-text cost note, when a rough tier is known. */
  costNote?: string;
}

/** True when the id looks like a non-chat model (embeddings / rerank / TTS-STT). */
export function isNonChatModel(id: string): boolean {
  return /embed|embedding|rerank|reranker|whisper|tts|stt|moderation|guard/i.test(id);
}

/**
 * Map a model id to its likely capabilities. Unknown ids fall back to a plain
 * text+tool-use chat model (the safe default for an OpenAI-compatible endpoint).
 */
export function modelCapabilities(id: string): ModelCapabilities {
  const m = id.toLowerCase();

  // Audio-only / embedding-only models: no chat, no tools.
  if (/whisper|tts|stt/.test(m)) {
    return { text: false, reasoning: false, vision: false, audio: true, toolUse: false };
  }
  if (/embed|embedding|rerank|moderation|guard/.test(m)) {
    return { text: false, reasoning: false, vision: false, audio: false, toolUse: false };
  }

  const reasoning = /reason|reasonix|thinking|-o\d|^o\d|codex|deepseek-r|qwq|-r1\b|r1-/.test(m);
  const vision = /vision|-vl\b|vl-|multimodal|omni|-4o|4\.5|claude-(opus|sonnet)|gpt-5|gemini/.test(m);
  const audio = /audio|omni|-4o|realtime/.test(m);

  let contextK: number | undefined;
  if (/gpt-5|claude-(opus|sonnet|fable)|1m|gemini-1\.5|gemini-2/.test(m)) contextK = 200;
  else if (/gpt-4|claude|qwen|deepseek|glm|llama-3|mixtral/.test(m)) contextK = 128;
  else if (/gpt-3\.5|llama-2/.test(m)) contextK = 16;

  let costNote: string | undefined;
  if (/local|ollama|lm-?studio|qwen|deepseek|glm|llama|mixtral|mistral/.test(m)) costNote = "local / low cost";
  else if (/mini|haiku|flash|small|lite|nano|turbo/.test(m)) costNote = "low cost";
  else if (/opus|gpt-5|ultra|large|pro\b/.test(m)) costNote = "premium";

  return { text: true, reasoning, vision, audio, toolUse: true, contextK, costNote };
}

/** Compact capability badges (label + title) for rendering next to a model row. */
export function capabilityBadges(cap: ModelCapabilities): Array<{ key: string; label: string; title: string }> {
  const out: Array<{ key: string; label: string; title: string }> = [];
  if (cap.reasoning) out.push({ key: "reasoning", label: "reason", title: "Reasoning / chain-of-thought" });
  if (cap.vision) out.push({ key: "vision", label: "vision", title: "Image input" });
  if (cap.audio) out.push({ key: "audio", label: "audio", title: "Audio input" });
  if (cap.toolUse) out.push({ key: "tools", label: "tools", title: "Tool / function calling" });
  if (cap.contextK) out.push({ key: "ctx", label: `${cap.contextK}k`, title: `~${cap.contextK}k token context window` });
  if (cap.costNote) out.push({ key: "cost", label: cap.costNote, title: "Approximate cost tier" });
  return out;
}
