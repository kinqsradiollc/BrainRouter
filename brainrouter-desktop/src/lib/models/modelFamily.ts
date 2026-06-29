/**
 * Pure model-FAMILY detector — maps a model id (claude-opus-4-8 → Claude,
 * gpt-5.5 → OpenAI, z-ai/glm-5.2 → GLM, …) to a lobehub brand-icon key, or null
 * when unrecognized.
 *
 * Lives in `lib/` (not in the `ModelIcon` component) so it has NO React / Vite
 * `?raw` imports and can be consumed by both the icon component AND the
 * `reasoningProfile` logic — and unit-tested under `tsx --test` / `node:test`,
 * which can't process `?raw` asset imports.
 */

// First match wins — order specific patterns before broad ones. Matched against
// the lower-cased model id (which may include a vendor prefix like "z-ai/").
const RULES: Array<[RegExp, string]> = [
  [/claude|anthropic/, 'claude'],
  [/gemini/, 'gemini'],
  [/gemma/, 'gemma'],
  [/gpt|openai|chatgpt|davinci|\bo[1345](?:-|\b)/, 'openai'],
  [/qwen|qwq/, 'qwen'],
  [/deepseek/, 'deepseek'],
  [/mi[sx]tral|magistral|codestral|ministral|pixtral|devstral/, 'mistral'],
  [/llama|meta-/, 'meta'],
  [/glm|chatglm|z-ai|zhipu|cogview/, 'chatglm'],
  [/grok/, 'grok'],
  [/command|cohere|\baya\b/, 'cohere'],
  [/phi-?\d/, 'microsoft'],
  [/kimi/, 'kimi'],
  [/moonshot/, 'moonshot'],
  [/nemotron|nvidia/, 'nvidia'],
  [/minimax|abab/, 'minimax'],
  [/doubao/, 'doubao'],
  [/baichuan/, 'baichuan'],
  [/perplexity|sonar/, 'perplexity'],
  [/hunyuan/, 'hunyuan'],
  [/\byi-/, 'yi'],
];

/** The detected model family id (lobehub key), or null when unrecognized. */
export function modelFamily(model: string): string | null {
  const m = (model || '').toLowerCase();
  for (const [re, fam] of RULES) if (re.test(m)) return fam;
  return null;
}
