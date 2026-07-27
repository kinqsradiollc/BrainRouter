// The `/config <key> [value]` get/set surface: the KEY_HANDLERS registry (one
// get/set pair per settable key) plus the web-search / computer-use / automation
// handler factories and the printKey/setKey entrypoints. listKnownConfigKeys()
// (in ./args.ts) enumerates KEY_HANDLERS for tab-completion + tests.
import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import { configSchemaFields, saveConfig, getCliKnobs, setCliKnobOverride, _resetCliKnobsCache } from '@kinqs/brainrouter-core/config';
import { listProviderNames, maskApiKey } from '@kinqs/brainrouter-core/provider';
import {
  readPreferences,
  writePreferences,
  resolveEffort,
  setSessionRuntime,
  type Preferences,
  type EffortLevel,
  type ExecutionMode,
  type ReviewPolicy,
} from '@kinqs/brainrouter-core/session';
import { isKnownSegment } from '../../view/statusline.js';
import {
  TRUE_WORDS, FALSE_WORDS, ensureWebSearchConfig, findDefaultProviderName,
  setDefaultProvider, type ConfigKeyHandler,
} from './shared.js';
import { readAutomationKnob, applyAutomationKnob } from './automation.js';
import { schemaHandlerForKey } from './schemaRenderer.js';

function automationHandler(key: string): ConfigKeyHandler {
  return {
    get: (ctx) => readAutomationKnob(ctx.config, key),
    set: (ctx, value) => {
      const result = applyAutomationKnob(ctx.config, key, value);
      if (!result.ok) return result;
      saveConfig(ctx.config);
      _resetCliKnobsCache(); // pick up the change live (next getCliKnobs reloads)
      return result;
    },
  };
}

function webSearchHandler(path: 'provider' | 'serperApiKey' | 'googleApiKey' | 'googleCx' | 'braveApiKey' | 'searxngBaseUrl' | 'respectRobots'): ConfigKeyHandler {
  return {
    get: (ctx) => {
      const ws = ctx.config.cli?.webSearch ?? {};
      switch (path) {
        case 'provider': return ws.provider ?? getCliKnobs().webSearch.provider;
        case 'serperApiKey': return ws.serperApiKey ? maskApiKey(ws.serperApiKey) : '(unset)';
        case 'googleApiKey': return ws.google?.apiKey ? maskApiKey(ws.google.apiKey) : '(unset)';
        case 'googleCx': return ws.google?.cx ? '(set)' : '(unset)';
        case 'braveApiKey': return ws.braveApiKey ? maskApiKey(ws.braveApiKey) : '(unset)';
        case 'searxngBaseUrl': return ws.searxngBaseUrl ?? '(unset)';
        case 'respectRobots': return ws.crawler?.respectRobots === false ? 'off' : 'on';
      }
    },
    set: (ctx, value) => {
      const ws = ensureWebSearchConfig(ctx);
      const v = value.trim();
      if (path === 'provider') {
        if (!['google_pse', 'serper', 'brave', 'searxng', 'custom_http'].includes(v)) {
          return { ok: false, reason: `web-search.provider must be google_pse|serper|brave|searxng|custom_http (got "${value}")` };
        }
        ws.provider = v as NonNullable<typeof ws.provider>;
      } else if (path === 'serperApiKey') ws.serperApiKey = v;
      else if (path === 'googleApiKey') ws.google = { ...(ws.google ?? {}), apiKey: v };
      else if (path === 'googleCx') ws.google = { ...(ws.google ?? {}), cx: v };
      else if (path === 'braveApiKey') ws.braveApiKey = v;
      else if (path === 'searxngBaseUrl') {
        try { new URL(v); } catch { return { ok: false, reason: 'web-search.searxng-url must be a valid URL' }; }
        ws.searxngBaseUrl = v;
      } else {
        const on = TRUE_WORDS.includes(v.toLowerCase());
        const off = FALSE_WORDS.includes(v.toLowerCase());
        if (!on && !off) return { ok: false, reason: `web-search.respect-robots must be on|off (got "${value}")` };
        ws.crawler = { ...(ws.crawler ?? {}), respectRobots: on };
      }
      saveConfig(ctx.config);
      _resetCliKnobsCache();
      return { ok: true, message: `web-search.${path} saved` };
    },
  };
}

function computerUseHandler(path: 'enabled' | 'mode'): ConfigKeyHandler {
  return {
    get: (ctx) => {
      const c = ctx.config.cli?.computerUse ?? {};
      return path === 'enabled' ? (c.enabled ? 'on' : 'off') : (c.mode ?? getCliKnobs().computerUse.mode);
    },
    set: (ctx, value) => {
      ctx.config.cli = ctx.config.cli ?? {};
      ctx.config.cli.computerUse = ctx.config.cli.computerUse ?? {};
      if (path === 'enabled') {
        const v = value.toLowerCase().trim();
        const on = TRUE_WORDS.includes(v);
        const off = FALSE_WORDS.includes(v);
        if (!on && !off) return { ok: false, reason: `computer-use.enabled must be on|off (got "${value}")` };
        ctx.config.cli.computerUse.enabled = on;
      } else {
        const v = value.trim();
        if (!v) return { ok: false, reason: 'computer-use.mode cannot be empty' };
        ctx.config.cli.computerUse.mode = v;
      }
      saveConfig(ctx.config);
      _resetCliKnobsCache();
      return { ok: true, message: `computer-use.${path} saved` };
    },
  };
}

export const KEY_HANDLERS: Record<string, ConfigKeyHandler> = {
  theme: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).theme,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['auto', 'light', 'dark', 'mono'].includes(v)) {
        return { ok: false, reason: `theme must be auto|light|dark|mono (got "${value}")` };
      }
      writePreferences(ctx.agent.workspaceRoot, { theme: v as Preferences['theme'] });
      return { ok: true, message: `theme → ${v}` };
    },
  },
  statusline: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).statusline,
    set: (ctx, value) => {
      const segments = value.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = segments.filter((s) => !isKnownSegment(s));
      if (unknown.length > 0) return { ok: false, reason: `unknown segment(s): ${unknown.join(', ')}` };
      writePreferences(ctx.agent.workspaceRoot, { statusline: segments.join(',') });
      return { ok: true, message: `statusline → ${segments.join(',')}` };
    },
  },
  effort: {
    get: (ctx) => `${resolveEffort(ctx.agent.workspaceRoot).effort} (${resolveEffort(ctx.agent.workspaceRoot).source})`,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['low', 'medium', 'high', 'xhigh'].includes(v)) return { ok: false, reason: `effort must be low|medium|high|xhigh (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { effort: v as EffortLevel });
      return { ok: true, message: `effort → ${v}` };
    },
  },
  mode: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).executionMode,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['planning', 'fast'].includes(v)) return { ok: false, reason: `mode must be planning|fast (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { executionMode: v as ExecutionMode });
      return { ok: true, message: `execution mode → ${v}` };
    },
  },
  'review-policy': {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).reviewPolicy,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['request', 'proceed'].includes(v)) return { ok: false, reason: `review-policy must be request|proceed (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { reviewPolicy: v as ReviewPolicy });
      return { ok: true, message: `review policy → ${v}` };
    },
  },
  quiet: {
    get: (ctx) => (readPreferences(ctx.agent.workspaceRoot).quiet ? 'on' : 'off'),
    set: (ctx, value) => {
      const v = value.toLowerCase();
      const on = ['on', 'true', '1', 'yes'].includes(v);
      const off = ['off', 'false', '0', 'no'].includes(v);
      if (!on && !off) return { ok: false, reason: `quiet must be on|off (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { quiet: on });
      setCliKnobOverride({ quiet: on });
      return { ok: true, message: `quiet → ${on ? 'on' : 'off'}` };
    },
  },
  personality: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).personality,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['concise', 'standard', 'detailed', 'pair-programmer'].includes(v)) {
        return { ok: false, reason: `personality must be concise|standard|detailed|pair-programmer (got "${value}")` };
      }
      writePreferences(ctx.agent.workspaceRoot, { personality: v as Preferences['personality'] });
      return { ok: true, message: `personality → ${v}` };
    },
  },
  editor: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).editorMode,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['emacs', 'vi'].includes(v)) return { ok: false, reason: `editor must be emacs|vi (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { editorMode: v as Preferences['editorMode'] });
      return { ok: true, message: `editor → ${v} (restart to apply)` };
    },
  },
  model: {
    get: (ctx) => ctx.config.llm?.model ?? '(unset)',
    set: (ctx, value) => {
      if (!value.trim()) return { ok: false, reason: 'model name cannot be empty' };
      ctx.agent.setModel(value.trim());
      if (ctx.config.llm) {
        ctx.config.llm.model = value.trim();
        saveConfig(ctx.config);
        setSessionRuntime(ctx.agent.workspaceRoot, ctx.agent.sessionKey, { model: '' });
      }
      return { ok: true, message: `model → ${value.trim()}` };
    },
  },
  provider: {
    get: (ctx) => {
      return findDefaultProviderName(ctx) ?? '(not saved as a Provider)';
    },
    set: async (ctx, value) => {
      const name = value.trim();
      if (!setDefaultProvider(ctx, name)) {
        const known = listProviderNames(ctx.config);
        return { ok: false, reason: known.length ? `unknown Provider "${name}" — choose one of: ${known.join(', ')}` : 'no Providers configured — open /config and add one under Providers first' };
      }
      return { ok: true, message: `primary provider → ${name} · ${ctx.config.llm?.model ?? ''}` };
    },
  },
  'automation': automationHandler('automation'),
  'automation.requirements': automationHandler('automation.requirements'),
  'automation.sync': automationHandler('automation.sync'),
  'automation.sprints': automationHandler('automation.sprints'),
  'web-search.provider': webSearchHandler('provider'),
  'web-search.serper-api-key': webSearchHandler('serperApiKey'),
  'web-search.google-api-key': webSearchHandler('googleApiKey'),
  'web-search.google-cx': webSearchHandler('googleCx'),
  'web-search.brave-api-key': webSearchHandler('braveApiKey'),
  'web-search.searxng-url': webSearchHandler('searxngBaseUrl'),
  'web-search.respect-robots': webSearchHandler('respectRobots'),
  'computer-use.enabled': computerUseHandler('enabled'),
  'computer-use.mode': computerUseHandler('mode'),
};

export function printKey(ctx: CommandContext, key: string): void {
  const handler = KEY_HANDLERS[key] ?? schemaHandlerForKey(key);
  if (!handler) {
    console.log(chalk.red(`\n  Unknown config key "${key}".`));
    console.log(chalk.gray(`  Known keys: ${[...Object.keys(KEY_HANDLERS), ...configSchemaFields().map((f) => f.path)].join(', ')}.  Run /config (bare) for the interactive panel.\n`));
    return;
  }
  console.log(`\n  ${chalk.cyan(key)}: ${chalk.bold(handler.get(ctx))}\n`);
}

export async function setKey(ctx: CommandContext, key: string, value: string): Promise<void> {
  const handler = KEY_HANDLERS[key] ?? schemaHandlerForKey(key);
  if (!handler || !handler.set) {
    console.log(chalk.red(`\n  /config can't set "${key}" directly.`));
    console.log(chalk.gray(`  Run /config (bare) and pick "${key}" interactively, or pick one of: ${[...Object.keys(KEY_HANDLERS), ...configSchemaFields().map((f) => f.path)].join(', ')}.\n`));
    return;
  }
  const result = await handler.set(ctx, value);
  if (!result.ok) {
    console.log(chalk.red(`\n  ✗ ${result.reason}\n`));
    return;
  }
  console.log(chalk.green(`\n  ✓ ${result.message}\n`));
}
