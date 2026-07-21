/**
 * Strict persistence boundary for replacing the base LLM configuration.
 * Interactive editors must not update the live Agent or announce success until
 * the complete config is durable; a failed write restores the exact prior
 * optional-property state and object identity.
 */
import type { Config, LLMConfig } from '@kinqs/brainrouter-core/config';
import { commitConfigProjection } from '../../configCommit.js';

export function persistLlmConfig(
  config: Config,
  next: LLMConfig,
  persist?: (value: Config) => void,
): void {
  commitConfigProjection(config, (candidate) => {
    candidate.llm = structuredClone(next);
  }, persist);
}
