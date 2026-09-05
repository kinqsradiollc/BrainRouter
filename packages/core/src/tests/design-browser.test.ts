/**
 * ADR-056 D-B1 — the browser engine: the same rule ids over computed styles in
 * the in-app browser. The control command validates and bounds; the core side
 * folds the page audit into detector findings and honours suppressions; a head
 * without a port SAYS it stayed static; with a port both engines report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseBrowserControlCommand } from '../browser/control.js';
import { requestBrowserDesignAudit, BROWSER_ENGINE_RULE_IDS, BROWSER_ENGINE_UNAVAILABLE, DESIGN_RULES, parseDesignSuppressions } from '../design/index.js';
import { designHandlers } from '../extension/builtin/handlers/design.js';
import { withTempWorkspaceAsync } from './_helpers.js';

const AUDIT = { url: 'http://localhost:5173/pricing', viewport: { width: 1280, height: 800 }, scanned: 412, findings: [
  { rule: 'low-contrast', message: 'Contrast 2.91:1 against the composited background (needs 4.5:1).', selector: 'main > p.muted', snippet: 'Cancel anytime' },
  { rule: 'text-overflow', message: 'Text is clipped: 640px of content in a 320px box with overflow hidden.', selector: 'div.card > h3' },
  { rule: 'horizontal-overflow', message: 'The page scrolls horizontally in the first viewport: content is 40px wider than the 1280px viewport.', selector: 'html' },
  { rule: 'side-stripe-border', message: 'not a browser rule — must be dropped', selector: 'div' },
  { rule: 'nope', message: 'unknown', selector: 'div' },
], truncated: false };

test('B1 page.designAudit validates: rule ids filtered, bounds applied, tab target kept', () => {
  const cmd = parseBrowserControlCommand({ kind: 'page.designAudit', tabId: 'tab_1', rules: ['low-contrast', 'Not Valid!', 'tiny-text'], maxFindings: 40 }) as { kind: string; tabId?: string; rules?: string[]; maxFindings?: number };
  assert.equal(cmd.kind, 'page.designAudit'); assert.equal(cmd.tabId, 'tab_1'); assert.deepEqual(cmd.rules, ['low-contrast', 'tiny-text']); assert.equal(cmd.maxFindings, 40);
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.designAudit', maxFindings: 5000 }));
  const browserRules = DESIGN_RULES.filter((r) => r.engine === 'browser').map((r) => r.id).sort();
  assert.deepEqual(browserRules, ['hidden-at-rest', 'horizontal-overflow', 'text-overflow']);
  for (const id of ['low-contrast', 'tiny-text', 'small-touch-target']) assert.ok(BROWSER_ENGINE_RULE_IDS.includes(id), `${id} is raised by both engines`);
});

test('B1 the audit folds into detector findings: registry severity, browser: file, suppressions honoured, unknown rules dropped', async () => {
  const sent: unknown[] = [];
  const port = { request: async (command: unknown) => { sent.push(command); return { ok: true, data: AUDIT }; } };
  const audit = await requestBrowserDesignAudit(port, { tabId: 'tab_1', rules: ['low-contrast', 'text-overflow', 'horizontal-overflow', 'side-stripe-border'], suppressions: parseDesignSuppressions({ ignoreRules: ['horizontal-overflow'] }) });
  assert.deepEqual(sent[0], { kind: 'page.designAudit', tabId: 'tab_1', rules: ['low-contrast', 'text-overflow', 'horizontal-overflow'] });
  assert.equal(audit.url, 'http://localhost:5173/pricing'); assert.equal(audit.scanned, 412);
  assert.deepEqual(audit.findings.map((f) => f.rule), ['low-contrast', 'text-overflow']);
  assert.equal(audit.findings[0].severity, 'error'); assert.equal(audit.findings[0].file, 'browser:http://localhost:5173/pricing'); assert.equal(audit.findings[0].engine, 'browser');
  assert.match(audit.findings[0].snippet ?? '', /main > p\.muted “Cancel anytime”/);
  assert.deepEqual(audit.suppressed.map((s) => [s.rule, s.reason]), [['horizontal-overflow', 'ignoreRules']]);
  await assert.rejects(requestBrowserDesignAudit({ request: async () => ({ ok: false, error: 'no tab' }) }), /refused the design audit: no tab/);
});

test('B1 design_detect with browser: true — says "static only" without a port, reports both engines with one', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'page.html'), '<!doctype html><html><head><style>.card{border-left:4px solid #e11d48}</style></head><body><div class="card">x</div></body></html>');
    const base = { workspaceRoot: ws, silent: false } as any;
    const staticOnly = String(await designHandlers.design_detect({ args: { paths: ['src'], browser: true }, host: base } as any));
    assert.match(staticOnly, /side-stripe-border/); assert.ok(staticOnly.includes(BROWSER_ENGINE_UNAVAILABLE));
    const port = { request: async () => ({ ok: true, data: AUDIT }) };
    const both = String(await designHandlers.design_detect({ args: { paths: ['src'], browser: true, tabId: 'tab_1' }, host: { ...base, browserControlPort: port } } as any));
    assert.match(both, /side-stripe-border/); assert.match(both, /Browser engine \(http:\/\/localhost:5173\/pricing, 1280×800\): 3 finding\(s\) over 412 element\(s\)/);
    assert.match(both, /- \[error\] low-contrast main > p\.muted “Cancel anytime” — Contrast 2\.91:1/); assert.ok(!both.includes('nope'));
    const silent = String(await designHandlers.design_detect({ args: { paths: ['src'], browser: true }, host: { ...base, silent: true, browserControlPort: port } } as any));
    assert.ok(silent.includes(BROWSER_ENGINE_UNAVAILABLE), 'a silent (delegated) agent must not drive the visible browser');
    const failing = String(await designHandlers.design_detect({ args: { paths: ['src'], browser: true }, host: { ...base, browserControlPort: { request: async () => { throw new Error('port closed'); } } } } as any));
    assert.match(failing, /Browser engine did not run: port closed\. Static results only\./);
  });
});
