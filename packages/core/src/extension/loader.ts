/**
 * EXTENSION-LOADER (0.4.15) — at agent startup: discover extensions across the
 * tiers, drop disabled ones, GATE workspace-tier extensions on project trust
 * (untrusted workspace code never auto-activates), `import()` each entry module,
 * and call its `activate(host)` — fault-isolated so one bad extension can't abort
 * startup. After activation it refreshes the provider catalog so code-defined
 * providers become visible.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { listExtensions, type ExtensionInfo } from './manifest.js';
import { isExtensionEnabled } from './extensionStore.js';
import { isWorkspaceTrusted } from '../workspace/workspaceTrust.js';
import { createExtensionHost, type ExtensionActivate } from './host.js';
import { resetExtensionContributions } from './registry.js';
import { refreshProviderCatalog } from '../provider/catalog.js';

export interface ExtensionLoadResult {
  activated: string[];
  /** Workspace-tier extensions skipped because the workspace isn't trusted. */
  skippedUntrusted: ExtensionInfo[];
  skippedDisabled: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Load + activate all eligible extensions for `workspaceRoot`. Idempotent:
 * resets prior contributions first, so it's safe to call again on reload.
 */
export async function loadExtensions(
  workspaceRoot: string,
  opts: { version?: string } = {},
): Promise<ExtensionLoadResult> {
  resetExtensionContributions();
  const result: ExtensionLoadResult = { activated: [], skippedUntrusted: [], skippedDisabled: [], errors: [] };
  const trusted = isWorkspaceTrusted(workspaceRoot);

  for (const ext of listExtensions(workspaceRoot)) {
    if (!isExtensionEnabled(ext.name)) {
      result.skippedDisabled.push(ext.name);
      continue;
    }
    // Workspace-provided code is arbitrary code from a clone — gate it on trust.
    // Built-in (ships with the binary) and user (installed in $HOME) extensions
    // are not workspace code and load without a per-repo trust prompt.
    if (ext.source === 'workspace' && !trusted) {
      result.skippedUntrusted.push(ext);
      continue;
    }
    if (!fs.existsSync(ext.entry)) {
      result.errors.push({ name: ext.name, error: `entry module not found: ${ext.entry}` });
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(ext.entry).href)) as { activate?: ExtensionActivate };
      if (typeof mod.activate !== 'function') {
        result.errors.push({ name: ext.name, error: 'module does not export activate(host)' });
        continue;
      }
      await mod.activate(createExtensionHost(ext.name, workspaceRoot, opts.version ?? ext.version));
      result.activated.push(ext.name);
    } catch (err) {
      // Fault isolation: a throwing extension is logged + skipped, never fatal.
      result.errors.push({ name: ext.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Code-defined providers only become visible after the catalog is rebuilt.
  if (result.activated.length > 0) refreshProviderCatalog();
  return result;
}
