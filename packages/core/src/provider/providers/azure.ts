import type { ProviderDefinition } from './definition.js';

/** Azure OpenAI — endpoint is PER-RESOURCE, so (like `openai-compatible`) the
 *  base URL is left EMPTY and the user supplies their own, e.g.
 *  `https://<resource>.openai.azure.com/openai/v1`. Because the endpoint is
 *  empty it never participates in `findProviderByEndpoint` (a config matches by
 *  the `azure` provider id instead).
 *
 *  Reasoning fields UNDECLARED — capabilities depend on the deployed model, so
 *  the shared conservative default applies. NOTE: Azure's `/models` (or
 *  `/openai/deployments`) often wants an `api-version` query + `api-key` header
 *  rather than `Bearer`, so a model probe may return nothing; the Desktop dialog
 *  keeps a free-text default-model fallback for exactly this case. */
export const azure: ProviderDefinition = {
  id: 'azure',
  label: 'Azure OpenAI',
  hint: 'cloud · your-resource.openai.azure.com · you provide the base URL',
  endpoint: '',
  envKey: 'AZURE_OPENAI_API_KEY',
  local: false,
  pickerVisible: true,
};
