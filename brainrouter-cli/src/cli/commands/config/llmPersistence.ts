/**
 * Strict persistence boundary for replacing the base LLM configuration.
 * Interactive editors must not update the live Agent or announce success until
 * the complete config is durable; a failed write restores the exact prior
 * optional-property state and object identity.
 */
import {
  saveConfigOrThrow,
  type Config,
  type LLMConfig,
} from '@kinqs/brainrouter-core/config';

export function persistLlmConfig(
  config: Config,
  next: LLMConfig,
  persist: (value: Config) => void = saveConfigOrThrow,
): void {
  const hadLlm = Object.prototype.hasOwnProperty.call(config, 'llm');
  const previous = config.llm;
  config.llm = next;
  try {
    persist(config);
  } catch (error) {
    if (hadLlm) config.llm = previous;
    else delete config.llm;
    throw error;
  }
}
