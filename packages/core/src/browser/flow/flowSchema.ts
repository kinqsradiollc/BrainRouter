/**
 * Saved-flow YAML schema (Layer: saved tests). A flow is a name + an ordered list
 * of steps; YAML keeps them human-editable. Validated through Zod on both parse
 * and serialize so a hand-edited flow can't smuggle an invalid step into a run.
 */
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const FlowStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), target: z.string() }),
  z.object({ action: z.literal('tap'), target: z.string() }),
  z.object({ action: z.literal('type'), target: z.string(), text: z.string() }),
  z.object({ action: z.literal('assertVisible'), target: z.string() }),
]);

export const FlowSchema = z.object({
  name: z.string(),
  steps: z.array(FlowStepSchema),
});

export type ParsedFlow = z.infer<typeof FlowSchema>;

/** Parse + validate a `.flow.yaml`. Throws (Zod) on an invalid flow. */
export function parseFlowYaml(text: string): ParsedFlow {
  return FlowSchema.parse(parseYaml(text));
}

/** Validate + serialize a flow to YAML. */
export function serializeFlowYaml(flow: ParsedFlow): string {
  return stringifyYaml(FlowSchema.parse(flow));
}
