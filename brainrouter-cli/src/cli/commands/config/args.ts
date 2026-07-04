// Pure arg parsing for the `/config` command (exported for tests) and the
// settable-key enumeration used by tab-completion.
import { KEY_HANDLERS } from './keyHandlers.js';
import { configSchemaFields } from '@kinqs/brainrouter-core/config';

export type ParsedConfigArgs =
  | { mode: 'home' }
  | { mode: 'raw' }
  | { mode: 'get'; key: string }
  | { mode: 'set'; key: string; value: string };

export function parseConfigArgs(args: string[]): ParsedConfigArgs {
  if (args.length === 0) return { mode: 'home' };
  const first = args[0].toLowerCase();
  if (first === 'raw' || first === '--raw' || first === 'json') return { mode: 'raw' };
  if (args.length === 1) return { mode: 'get', key: first };
  return { mode: 'set', key: first, value: args.slice(1).join(' ').trim() };
}

export function listKnownConfigKeys(): string[] {
  return [...Object.keys(KEY_HANDLERS), ...configSchemaFields().map((field) => field.path)];
}
