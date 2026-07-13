/**
 * Saved test flows — an ordered list of steps replayed through the command layer.
 * P2 defines the step shape + the replay engine (short-circuit on first failure);
 * P6 adds YAML load/save + record. A step's `target` is an element id (tap/type/
 * assertVisible) or a screen id (navigate).
 */
import type { UiCommandResult } from '../types.js';
import type { CommandLayer } from './commands.js';
import { errorResult } from './normalize.js';

export type FlowStep =
  | { action: 'navigate'; target: string }
  | { action: 'tap'; target: string }
  | { action: 'type'; target: string; text: string }
  | { action: 'assertVisible'; target: string };

export interface Flow {
  name: string;
  steps: FlowStep[];
}

export interface RunFlowOptions {
  /** Stop at the first non-ok step (default true). */
  stopOnFail?: boolean;
  /** Fired after each step settles — lets the panel stream progress. */
  onStep?: (result: UiCommandResult, index: number) => void;
}

async function runStep(layer: CommandLayer, step: FlowStep): Promise<UiCommandResult> {
  switch (step.action) {
    case 'navigate':
      return layer.navigate(step.target);
    case 'tap':
      return layer.tap(step.target);
    case 'type':
      return layer.type(step.target, step.text);
    case 'assertVisible':
      return layer.assertVisible(step.target);
    default:
      return errorResult('runFlow', `unknown step action: ${String((step as { action?: string }).action)}`);
  }
}

export async function runFlow(layer: CommandLayer, steps: FlowStep[], opts: RunFlowOptions = {}): Promise<UiCommandResult[]> {
  const stopOnFail = opts.stopOnFail ?? true;
  const out: UiCommandResult[] = [];
  for (let i = 0; i < steps.length; i++) {
    const result = await runStep(layer, steps[i]);
    out.push(result);
    opts.onStep?.(result, i);
    if (stopOnFail && !result.ok) break;
  }
  return out;
}
