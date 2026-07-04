// `/config` slash command — barrel + top-level dispatch.
//
// 0.3.7 redesign on the atomic-frame Ink picker. The command body was split into
// cohesive sibling modules (see each file header); this index wires them into
// the four-mode dispatch and re-exports the same public surface external callers
// (login, repl, config-command tests) already import.
//
// Persistence routes through `saveConfig` / `writePreferences` — never touches
// JSON files directly so future schema changes stay centralized.
import type { CommandContext } from '../_context.js';
import { parseConfigArgs } from './args.js';
import { runHomePanel } from './homePanel.js';
import { printRawConfig } from './rawConfig.js';
import { printKey, setKey } from './keyHandlers.js';

// --- Public entrypoint -------------------------------------------------

export async function tryHandleConfigCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/config') return false;
  const parsed = parseConfigArgs(ctx.args);
  switch (parsed.mode) {
    case 'home':
      await runHomePanel(ctx);
      return true;
    case 'raw':
      printRawConfig(ctx);
      return true;
    case 'get':
      printKey(ctx, parsed.key);
      return true;
    case 'set':
      await setKey(ctx, parsed.key, parsed.value);
      return true;
  }
}

// --- Public surface (unchanged names; consumed by login, tests) --------
export { parseConfigArgs, listKnownConfigKeys, type ParsedConfigArgs } from './args.js';
export {
  WIRE_FORMAT_OPTIONS,
  type WireFormatOption,
  type WireFormatOverride,
  type ProviderRequestFormatRow,
  listProviderRequestFormatRows,
  applyProviderRequestFormat,
} from './wireFormat.js';
export { readAutomationKnob, applyAutomationKnob } from './automation.js';
export { formatSchemaValue, parseSchemaValue, schemaHandlerForKey } from './schemaRenderer.js';
export { buildScrubbedConfigJson } from './rawConfig.js';
export { editLlm, promptBrainrouterApiKey } from './editors.js';
