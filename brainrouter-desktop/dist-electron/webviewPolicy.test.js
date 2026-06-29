import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedWebviewSrc, hardenWebviewPreferences } from './webviewPolicy.js';
test('isAllowedWebviewSrc: allows self-contained data:text/html', () => {
    assert.equal(isAllowedWebviewSrc('data:text/html,<h1>hi</h1>', '/repo'), true);
    assert.equal(isAllowedWebviewSrc('data:text/html;charset=utf-8,<h1>hi</h1>', '/repo'), true);
});
test('isAllowedWebviewSrc: refuses network + non-html data + empty', () => {
    assert.equal(isAllowedWebviewSrc('https://evil.example/x', '/repo'), false);
    assert.equal(isAllowedWebviewSrc('http://localhost/x', '/repo'), false);
    assert.equal(isAllowedWebviewSrc('data:image/svg+xml,<svg/>', '/repo'), false);
    assert.equal(isAllowedWebviewSrc('', '/repo'), false);
    assert.equal(isAllowedWebviewSrc('javascript:alert(1)', '/repo'), false);
});
test('isAllowedWebviewSrc: allows an authorized prototype file inside the workspace', () => {
    assert.equal(isAllowedWebviewSrc('file:///repo/proto/12345678.html', '/repo'), true);
});
test('isAllowedWebviewSrc: refuses files outside the workspace or with traversal or wrong type', () => {
    assert.equal(isAllowedWebviewSrc('file:///etc/passwd', '/repo'), false);
    assert.equal(isAllowedWebviewSrc('file:///other/proto/x.html', '/repo'), false);
    assert.equal(isAllowedWebviewSrc('file:///repo/src/secret.ts', '/repo'), false, 'non-proto file refused');
});
test('hardenWebviewPreferences: strips preload + node, forces sandbox/isolation', () => {
    const prefs = { preload: '/x/evil.js', nodeIntegration: true, sandbox: false, contextIsolation: false };
    hardenWebviewPreferences(prefs);
    assert.ok(!('preload' in prefs) || prefs.preload === undefined);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.webSecurity, true);
});
