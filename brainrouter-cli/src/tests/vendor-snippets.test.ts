import test from 'node:test';
import assert from 'node:assert/strict';

import { VENDORS, displayPath, getVendor, listVendors, renderSnippet } from '../runtime/vendorSnippets.js';
import { runMcpInstall } from '../cli/commands/mcpInstall.js';
import type { Config } from '../config/config.js';

const VARS = { url: 'https://api.brainrouter.cloud/mcp', apiKey: 'br_live_TEST_KEY' };

function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, '');
}

test('VENDORS includes the five minimum required vendors', () => {
  for (const id of ['claude-desktop', 'cursor', 'windsurf', 'vscode-continue', 'zed']) {
    assert.ok(VENDORS[id], `missing vendor ${id}`);
  }
  assert.ok(listVendors().length >= 5);
});

test('each vendor template renders an object containing the URL and API key verbatim', () => {
  for (const entry of listVendors()) {
    const snippet = renderSnippet(entry, VARS);
    assert.ok(snippet.includes(VARS.url), `${entry.id} missing url`);
    assert.ok(snippet.includes(VARS.apiKey), `${entry.id} missing apiKey verbatim`);
    // Sanity: round-trips as JSON.
    JSON.parse(snippet);
  }
});

test('claude-desktop uses mcpServers.<id>.url + Authorization header', () => {
  const obj = VENDORS['claude-desktop'].template(VARS) as any;
  assert.equal(obj.mcpServers.brainrouter.url, VARS.url);
  assert.equal(obj.mcpServers.brainrouter.headers.Authorization, `Bearer ${VARS.apiKey}`);
});

test('vscode-continue nests servers under experimental.modelContextProtocolServers', () => {
  const obj = VENDORS['vscode-continue'].template(VARS) as any;
  assert.ok(Array.isArray(obj.experimental.modelContextProtocolServers));
  assert.equal(obj.experimental.modelContextProtocolServers[0].transport.url, VARS.url);
});

test('zed snippet sits under context_servers', () => {
  const obj = VENDORS.zed.template(VARS) as any;
  assert.ok(obj.context_servers.brainrouter);
  assert.equal(obj.context_servers.brainrouter.url, VARS.url);
});

test('windsurf uses serverUrl (not url) per Codeium schema', () => {
  const obj = VENDORS.windsurf.template(VARS) as any;
  assert.equal(obj.mcpServers.brainrouter.serverUrl, VARS.url);
});

test('configPath resolves against the right OS', () => {
  const mac = VENDORS['claude-desktop'].configPath('darwin');
  assert.match(mac, /Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
  const lin = VENDORS.cursor.configPath('linux');
  assert.match(lin, /\.cursor\/mcp\.json$/);
});

test('displayPath converts to backslashes on Windows', () => {
  assert.equal(displayPath('/foo/bar/baz.json', 'win32'), '\\foo\\bar\\baz.json');
  assert.equal(displayPath('/foo/bar/baz.json', 'darwin'), '/foo/bar/baz.json');
});

test('getVendor is case-insensitive', () => {
  assert.equal(getVendor('CURSOR')?.id, 'cursor');
});

// --- runMcpInstall behavior ---------------------------------------------

const configWithProfile: Config = {
  activeServer: 'br',
  servers: {
    br: { type: 'http', url: 'https://x.brainrouter.cloud/mcp', apiKey: 'br_live_ABC', identity: 'brainrouter' },
  },
};

const configEmpty: Config = { activeServer: '', servers: {} };

test('runMcpInstall list renders one row per vendor', () => {
  const r = runMcpInstall(['list'], configWithProfile);
  assert.equal(r.ok, true);
  const text = stripAnsi(r.output);
  for (const v of listVendors()) assert.ok(text.includes(v.id), `list missing ${v.id}`);
});

test('runMcpInstall <vendor> substitutes live profile URL + API key', () => {
  const r = runMcpInstall(['cursor'], configWithProfile);
  assert.equal(r.ok, true);
  const text = stripAnsi(r.output);
  assert.ok(text.includes('https://x.brainrouter.cloud/mcp'));
  assert.ok(text.includes('br_live_ABC'));
  assert.ok(/live API key/.test(text), 'expected API-key warning');
});

test('runMcpInstall fails with /login hint when no active profile', () => {
  const r = runMcpInstall(['cursor'], configEmpty);
  assert.equal(r.ok, false);
  assert.match(stripAnsi(r.output), /\/login/);
});

test('runMcpInstall errors on unknown vendor', () => {
  const r = runMcpInstall(['notarealhost'], configWithProfile);
  assert.equal(r.ok, false);
  assert.match(stripAnsi(r.output), /Unknown vendor/);
});

test('runMcpInstall with no args prints help', () => {
  const r = runMcpInstall([], configWithProfile);
  assert.equal(r.ok, true);
  assert.match(stripAnsi(r.output), /Usage/);
});
