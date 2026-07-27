import type { ResolvedCliKnobs } from '../config/config.js';
import type { WebSearchProvider, WebSearchProviderId } from './types.js';
import { BraveSearchProvider } from './providers/brave.js';
import { CustomHttpSearchProvider } from './providers/customHttp.js';
import { GooglePseSearchProvider } from './providers/googlePse.js';
import { SearxngSearchProvider } from './providers/searxng.js';
import { SerperSearchProvider } from './providers/serper.js';

function requireValue(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new Error(`${field} is required for the selected web search provider.`);
  return trimmed;
}

export function buildSearchProvider(knobs: Pick<ResolvedCliKnobs, 'webSearch' | 'webSearchEndpoint'>): WebSearchProvider {
  if (knobs.webSearch.configurationError) throw new Error(knobs.webSearch.configurationError);
  const provider = (knobs.webSearch.provider ?? 'google_pse') as WebSearchProviderId;
  const legacyEndpoint = knobs.webSearchEndpoint?.trim();
  if (legacyEndpoint && provider === 'google_pse' && !knobs.webSearch.google.apiKey && !knobs.webSearch.google.cx) {
    return new CustomHttpSearchProvider(legacyEndpoint);
  }
  switch (provider) {
    case 'custom_http':
      return new CustomHttpSearchProvider(requireValue(legacyEndpoint, 'cli.webSearchEndpoint'));
    case 'serper':
      return new SerperSearchProvider(requireValue(knobs.webSearch.serperApiKey, 'cli.webSearch.serperApiKey'));
    case 'google_pse':
      return new GooglePseSearchProvider(
        requireValue(knobs.webSearch.google.apiKey, 'cli.webSearch.google.apiKey'),
        requireValue(knobs.webSearch.google.cx, 'cli.webSearch.google.cx'),
      );
    case 'brave':
      return new BraveSearchProvider(requireValue(knobs.webSearch.braveApiKey, 'cli.webSearch.braveApiKey'));
    case 'searxng':
      return new SearxngSearchProvider(requireValue(knobs.webSearch.searxngBaseUrl, 'cli.webSearch.searxngBaseUrl'));
    default:
      throw new Error(`Unsupported cli.webSearch.provider "${provider}".`);
  }
}
