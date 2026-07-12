/**
 * PLUGIN-MARKETPLACE P4-desktop — host-side plugin/marketplace bridge.
 *
 * The desktop Marketplace UI never touches the filesystem or git directly (the
 * renderer stays browser-safe). Instead it fires `plugin-*` / `action:plugin-*`
 * queries that the host process routes here; this module delegates to the shared
 * `@kinqs/brainrouter-core/plugin` runtime (the SAME code the CLI uses), so
 * install / enable / remove / consent are one implementation across surfaces.
 *
 * Every entry is wrapped to return a plain `{ ok, ... }` result rather than
 * throwing, so a malformed registry / missing plugin surfaces as a toast in the
 * renderer instead of crashing the host query router.
 */
import { loadPlugins, discoverPlugin, pluginInstallRoot, readInstallRecord, summarizeProvides, buildConsentSummary, setPluginEnabled, setPluginConsent, pluginConsent, installPlugin, installPluginByName, removePlugin, fetchAndSearch, } from '@kinqs/brainrouter-core/plugin';
import { loadOrInitConfig } from '@kinqs/brainrouter-core/config';
import { VERSION } from '@kinqs/brainrouter-core/version';
function authorName(author) {
    if (typeof author === 'string')
        return author;
    if (author && typeof author === 'object' && typeof author.name === 'string') {
        return author.name;
    }
    return undefined;
}
/** Compare two dotted semver-ish strings; 1 = a>b, -1 = a<b, 0 = equal/unknown. */
function compareVersions(a, b) {
    const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
    const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = Number.isFinite(pa[i]) ? pa[i] : 0;
        const y = Number.isFinite(pb[i]) ? pb[i] : 0;
        if (x !== y)
            return x > y ? 1 : -1;
    }
    return 0;
}
/**
 * List every installed plugin (enabled + disabled, both scopes), enriched with
 * consent + a registry-driven "update available" flag. Fetching the registry is
 * best-effort — a network failure just omits update badges.
 */
export async function listInstalledPlugins(workspaceRoot) {
    const config = loadOrInitConfig();
    const res = loadPlugins(workspaceRoot, config);
    // Registry versions (best-effort) keyed by lower-cased id/name, for update badges.
    const registryVersions = new Map();
    try {
        const search = await fetchAndSearch(config.cli?.plugins?.registryUrl, '', {});
        if (search.ok) {
            for (const hit of search.hits) {
                if (hit.entry.version)
                    registryVersions.set(hit.entry.id.toLowerCase(), hit.entry.version);
                if (hit.entry.version && hit.entry.name)
                    registryVersions.set(hit.entry.name.toLowerCase(), hit.entry.version);
            }
        }
    }
    catch { /* registry offline — no update badges, still list installed */ }
    const runtime = { brainrouterVersion: VERSION };
    const seen = new Map();
    const add = (plugin, enabled) => {
        const { name, scope } = plugin;
        if (seen.has(name))
            return; // workspace overrides user (loadPlugins order)
        const consent = pluginConsent(config, name);
        const summary = buildConsentSummary(plugin, { approved: consent, runtime });
        const record = readInstallRecord(plugin.root);
        const installedVer = plugin.manifest.version;
        const regVer = registryVersions.get(name.toLowerCase());
        const updateAvailable = regVer && installedVer && compareVersions(regVer, installedVer) > 0 ? regVer : undefined;
        seen.set(name, {
            name,
            scope,
            readOnly: plugin.readOnly === true || scope === 'org',
            version: installedVer,
            description: plugin.manifest.description,
            author: authorName(plugin.manifest.author),
            category: plugin.manifest.category,
            enabled,
            provides: summarizeProvides(plugin),
            requiresConsent: summary.requiresConsent,
            shellApproved: summary.shellApproved,
            mcpApproved: summary.mcpApproved,
            updateAvailable,
            source: record?.source,
            ref: record?.ref,
        });
    };
    for (const p of res.loaded)
        add(p, true);
    for (const p of res.disabled)
        add(p, false);
    return { plugins: [...seen.values()], skippedForSafeMode: res.skippedForSafeMode, errors: res.errors };
}
/** Search the hosted registry (or override). Returns flattened hits for the browse grid. */
export async function searchRegistryPlugins(query, opts = {}) {
    const config = loadOrInitConfig();
    const customUrl = (config.cli?.plugins?.registryUrl ?? '').trim();
    const res = await fetchAndSearch(customUrl || undefined, query, opts);
    // The built-in community registry isn't published yet (or was deleted): a
    // not-found on the DEFAULT registry is "no community index" — a clean empty
    // state, not an error. Installed plugins are unaffected either way. A custom
    // registryUrl that fails still surfaces the error (the user configured it).
    if (!res.ok && !customUrl && /HTTP 40[34]|not found|ENOTFOUND/i.test(res.error)) {
        return { ok: true, hits: [], fromCache: false };
    }
    return res;
}
/**
 * The consent/disclosure summary for a plugin, resolved from a registry entry
 * (by id) OR from an already-installed plugin (by name). Installed-first so a
 * re-install / re-enable shows current on-disk capabilities.
 */
export async function pluginConsentSummary(idOrName, workspaceRoot, scope = 'user') {
    const config = loadOrInitConfig();
    const runtime = { brainrouterVersion: VERSION };
    // Prefer an installed copy (real on-disk capabilities).
    const root = pluginInstallRoot(scope, idOrName, workspaceRoot);
    const disc = discoverPlugin(root);
    if (disc.ok) {
        return { ok: true, summary: buildConsentSummary(disc.plugin, { approved: pluginConsent(config, idOrName), runtime }) };
    }
    // Not installed yet — fall back to the registry entry's declared `provides`
    // counts so the dialog can still preview capabilities before download.
    const search = await fetchAndSearch(config.cli?.plugins?.registryUrl, '', {});
    if (!search.ok)
        return { ok: false, error: search.error };
    const hit = search.hits.find((h) => h.entry.id.toLowerCase() === idOrName.toLowerCase() || h.entry.name.toLowerCase() === idOrName.toLowerCase());
    if (!hit)
        return { ok: false, error: `plugin "${idOrName}" not found in the registry` };
    const p = hit.entry.provides;
    const parts = [];
    const push = (n, one) => { if (n)
        parts.push(`${n} ${n === 1 ? one : `${one}s`}`); };
    push(p.skills, 'skill');
    push(p.agents, 'agent');
    push(p.hooks, 'hook');
    push(p.mcpServers, 'MCP server');
    push(p.connectors, 'connector');
    push(p.workflows, 'workflow');
    const requiresConsent = (p.hooks ?? 0) > 0 || (p.mcpServers ?? 0) > 0;
    return {
        ok: true,
        summary: {
            name: hit.entry.name,
            version: hit.entry.version,
            provides: { skills: p.skills ?? 0, agents: p.agents ?? 0, commands: 0, hooks: p.hooks ?? 0, mcpServers: p.mcpServers ?? 0, connectors: p.connectors ?? 0, workflows: p.workflows ?? 0 },
            hookCommands: [],
            mcpCommands: [],
            requiresConsent,
            shellApproved: false,
            mcpApproved: false,
            compatibilityWarnings: [],
            disclosure: `${hit.entry.name}${hit.entry.version ? ` v${hit.entry.version}` : ''} provides ${parts.length ? parts.join(', ') : 'nothing'}.`,
        },
    };
}
/** Install a plugin by registry name/id (resolving through configured marketplaces). */
export function installPluginFromRegistry(name, opts = {}) {
    const r = installPluginByName(name, { scope: opts.scope, workspaceRoot: opts.workspaceRoot, force: opts.force, config: loadOrInitConfig() });
    if (!r.ok)
        return { ok: false, error: r.error };
    const installed = r.result && r.result.ok ? r.result.name : name;
    return { ok: true, name: installed };
}
/** Install a plugin from a raw source (local path OR git url). */
export function installPluginFromSource(source, opts = {}) {
    const r = installPlugin(source, opts);
    return r.ok ? { ok: true, name: r.name } : { ok: false, error: r.error };
}
/** Enable or disable an installed plugin (persists to `cli.plugins.enabled`). */
export function setPluginEnabledBridge(name, enabled) {
    setPluginEnabled(name, enabled);
    return { ok: true };
}
/** Record consent to a plugin's shell / MCP capabilities. */
export function setPluginConsentBridge(name, consent) {
    setPluginConsent(name, consent);
    return { ok: true };
}
/** Remove an installed plugin from a scope. */
export function removePluginBridge(name, opts = {}) {
    const r = removePlugin(name, opts);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
}
