/**
 * Story generation — the prompt + the validation for turning a UI map into named
 * user-journey stories via an LLM. Pure: the caller owns the model call. Build a
 * compact prompt from the map, then validate the model's proposed stories against
 * the map — drop any step whose target isn't a real screen id / element testID,
 * reject thin (<2-step) stories, slug ids — so a hallucinated id can never reach
 * a run. Reused by the desktop host (and, later, the agent).
 */
import type { UiMap } from '../types.js';
import { StorySchema, type Story } from '../flow/storySchema.js';

/** The forced-tool JSON Schema the model fills — an array of stories. */
export const STORY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short user-facing journey name.' },
          description: { type: 'string', description: 'One or two sentences: what the user does + the outcome.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['navigate', 'tap', 'type', 'assertVisible'] },
                target: { type: 'string', description: 'A screen id (navigate) or an element testID (tap/type/assertVisible), taken verbatim from the map.' },
                text: { type: 'string', description: 'Text to type (type action only).' },
              },
              required: ['action', 'target'],
            },
          },
        },
        required: ['title', 'description', 'steps'],
      },
    },
  },
  required: ['stories'],
} as const;

export interface StoryPrompt {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  toolSchema: typeof STORY_TOOL_SCHEMA;
}

/** Build the LLM prompt (system + user + forced-tool schema) from a UI map. */
export function buildStoryPrompt(uiMap: UiMap, opts: { count?: number } = {}): StoryPrompt {
  const count = opts.count ?? 5;
  const compact = {
    screens: uiMap.screens.map((s) => ({
      id: s.id,
      title: s.title,
      route: s.route ?? null,
      elements: s.elements.map((e) => ({ testID: e.testID, type: e.type, action: e.action, label: e.label })),
    })),
  };
  const system = [
    'You design realistic end-to-end UI test journeys ("stories") for a web app,',
    'given a map of its screens and interactive elements.',
    'Rules:',
    '- Use ONLY screen ids and element testIDs that appear in the map — never invent ids.',
    "- A step's target is a screen id for \"navigate\", otherwise an element testID.",
    '- Begin each journey with a "navigate" to the screen it starts on.',
    '- Prefer meaningful multi-step journeys (e.g. log in, add an item, submit a form, verify a result).',
    '- For a "type" step include a plausible `text` value.',
    `- Propose up to ${count} distinct stories.`,
  ].join('\n');
  const user = `Here is the UI map (JSON). Propose the stories.\n\n${JSON.stringify(compact)}`;
  return { system, user, toolName: 'propose_stories', toolDescription: 'Return an array of user-journey stories over the given UI map.', toolSchema: STORY_TOOL_SCHEMA };
}

/**
 * Validate the model's raw output against the map: keep only steps whose targets
 * exist (navigate → known screen id; tap/type/assert → known testID), drop stories
 * with fewer than 2 valid steps, slug + de-dupe ids. Never throws.
 */
export function validateStories(raw: unknown, uiMap: UiMap): Story[] {
  const screenIds = new Set(uiMap.screens.map((s) => s.id));
  const testIds = new Set(uiMap.screens.flatMap((s) => s.elements.map((e) => e.testID)));
  const out: Story[] = [];
  const usedIds = new Set<string>();

  for (const item of extractArray(raw)) {
    const st = item as { title?: unknown; description?: unknown; steps?: unknown };
    const title = typeof st.title === 'string' ? st.title.trim() : '';
    if (!title) continue;

    const steps: Story['steps'] = [];
    for (const s of Array.isArray(st.steps) ? st.steps : []) {
      const step = s as { action?: unknown; target?: unknown; text?: unknown };
      const target = typeof step.target === 'string' ? step.target : '';
      if (!target) continue;
      if (step.action === 'navigate') { if (screenIds.has(target)) steps.push({ action: 'navigate', target }); }
      else if (step.action === 'tap') { if (testIds.has(target)) steps.push({ action: 'tap', target }); }
      else if (step.action === 'assertVisible') { if (testIds.has(target)) steps.push({ action: 'assertVisible', target }); }
      else if (step.action === 'type') { if (testIds.has(target)) steps.push({ action: 'type', target, text: typeof step.text === 'string' ? step.text : 'test' }); }
    }
    if (steps.length < 2) continue;

    const base = slug(title);
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);

    const parsed = StorySchema.safeParse({ id, title, description: typeof st.description === 'string' ? st.description : '', steps });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function extractArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { stories?: unknown }).stories)) return (raw as { stories: unknown[] }).stories;
  if (typeof raw === 'string') { try { return extractArray(JSON.parse(raw)); } catch { return []; } }
  return [];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'story';
}
