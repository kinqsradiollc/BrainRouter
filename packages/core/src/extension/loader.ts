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
import { createExtensionHost, disposeExtensionHost, type ExtensionActivate, type ExtensionHost } from './host.js';
import { abortExtensionReload, beginExtensionReload, commitExtensionReload } from './registry.js';
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
 * stages a complete replacement and swaps it atomically, so a turn can never
 * observe a half-reloaded executor/policy catalog.
 */
export async function loadExtensions(
  workspaceRoot: string,
  opts: { version?: string } = {},
): Promise<ExtensionLoadResult> {
  beginExtensionReload();
  const result: ExtensionLoadResult = { activated: [], skippedUntrusted: [], skippedDisabled: [], errors: [] };
  const trusted = isWorkspaceTrusted(workspaceRoot);

  for (const ext of listExtensions(workspaceRoot)) {
    if (!ext.required && !isExtensionEnabled(ext.name)) {
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
      const error = `entry module not found: ${ext.entry}`;
      result.errors.push({ name: ext.name, error });
      if (ext.required) { abortExtensionReload(); throw new Error(`Required core extension "${ext.name}" failed: ${error}`); }
      continue;
    }
    // ADR-041 A41-9 — held across the try so a failed activate() can unwind the
    // host's PARTIAL registrations (see the catch).
    let host: ExtensionHost | undefined;
    try {
      const mod = (await import(pathToFileURL(ext.entry).href)) as { activate?: ExtensionActivate };
      if (typeof mod.activate !== 'function') {
        const error = 'module does not export activate(host)';
        result.errors.push({ name: ext.name, error });
        if (ext.required) { abortExtensionReload(); throw new Error(`Required core extension "${ext.name}" failed: ${error}`); }
        continue;
      }
      host = createExtensionHost(ext.name, workspaceRoot, opts.version ?? ext.version, { source: ext.source, required: ext.required });
      await mod.activate(host);
      result.activated.push(ext.name);
    } catch (err) {
      // Optional extensions are fault-isolated. A required core capability is a
      // startup invariant: keep the previous active snapshot and fail precisely.
      const error = err instanceof Error ? err.message : String(err);
      result.errors.push({ name: ext.name, error });
      if (ext.required) { abortExtensionReload(); throw new Error(`Required core extension "${ext.name}" failed: ${error}`); }
      // ADR-041 A41-9 — an optional extension that threw MID-activate left partial
      // registrations in staging (some tools/panels registered before the throw).
      // Unwind them in reverse so a half-activated extension contributes nothing;
      // a required failure already discarded the whole staging set via abort above.
      else if (host) disposeExtensionHost(host);
    }
  }

  commitExtensionReload();
  // Code-defined providers only become visible after the catalog is rebuilt.
  if (result.activated.length > 0) refreshProviderCatalog();
  return result;
}
