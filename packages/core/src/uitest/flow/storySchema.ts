/**
 * Saved-story YAML schema. A STORY is a named user JOURNEY — a title + a plain
 * description + an ordered list of the same steps a flow uses — so the Atlas can
 * list it, narrate it, trace its path across screens, and replay it. Distinct
 * from a flow (`name + steps`): a story adds `id/title/description`. Validated
 * through Zod on both parse and serialize so a hand-edited story can't smuggle an
 * invalid step into a run.
 */
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { FlowStepSchema } from './flowSchema.js';

export const StorySchema = z.object({
  /** Stable slug, e.g. `log-in-and-add-a-todo`. */
  id: z.string(),
  title: z.string(),
  /** One or two sentences of what the journey does. */
  description: z.string(),
  /** The ordered steps — same shape a flow replays. */
  steps: z.array(FlowStepSchema),
});

export type Story = z.infer<typeof StorySchema>;

/** Parse + validate a `.story.yaml`. Throws (Zod) on an invalid story. */
export function parseStoryYaml(text: string): Story {
  return StorySchema.parse(parseYaml(text));
}

/** Validate + serialize a story to YAML. */
export function serializeStoryYaml(story: Story): string {
  return stringifyYaml(StorySchema.parse(story));
}

/**
 * Parse + validate a JSON stories manifest — either `{ "stories": [...] }` or a
 * bare `[...]`. Non-throwing: malformed JSON yields `[]`, and any story that
 * fails `StorySchema` is skipped (so one bad entry can't drop the whole file).
 */
export function parseStoriesJson(text: string): Story[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { stories?: unknown }).stories)
      ? ((raw as { stories: unknown[] }).stories)
      : []);
  const out: Story[] = [];
  for (const item of arr) {
    const r = StorySchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}
