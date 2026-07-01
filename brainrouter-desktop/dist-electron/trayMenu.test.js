import test from 'node:test';
import assert from 'node:assert/strict';
import { shortenPath, buildTrayMenuModel } from './trayMenu.js';
test('shortenPath: keeps short paths, trims long ones to the last two segments', () => {
    assert.equal(shortenPath('project'), 'project');
    assert.equal(shortenPath('/a/b'), '/a/b'); // 2 segments
    assert.equal(shortenPath('/Users/me/code/BrainRouter'), '…/code/BrainRouter');
    assert.equal(shortenPath('C:\\Users\\me\\repo\\app'), '…/repo/app');
});
test('buildTrayMenuModel: show/hide reflects visibility; quit + recents submenu present', () => {
    const visible = buildTrayMenuModel({ windowVisible: true, recents: [] });
    assert.equal(visible[0].label, 'Hide BrainRouter');
    const hidden = buildTrayMenuModel({ windowVisible: false, recents: [] });
    assert.equal(hidden[0].label, 'Show BrainRouter');
    const labels = hidden.map((i) => i.label ?? i.type);
    assert.deepEqual(labels, ['Show BrainRouter', 'separator', 'Recent workspaces', 'separator', 'Quit BrainRouter']);
    assert.deepEqual(hidden[0].action, { kind: 'toggle-window' });
    assert.deepEqual(hidden[4].action, { kind: 'quit' });
});
test('buildTrayMenuModel: empty recents → a disabled placeholder', () => {
    const model = buildTrayMenuModel({ windowVisible: true, recents: [] });
    const submenu = model.find((i) => i.label === 'Recent workspaces').submenu;
    assert.equal(submenu.length, 1);
    assert.equal(submenu[0].enabled, false);
    assert.match(submenu[0].label, /No recent/);
});
test('buildTrayMenuModel: recents become open-workspace items, capped and labelled', () => {
    const recents = Array.from({ length: 12 }, (_, i) => `/Users/me/code/proj-${i}`);
    const submenu = buildTrayMenuModel({ windowVisible: true, recents, recentsCap: 5 })
        .find((i) => i.label === 'Recent workspaces').submenu;
    assert.equal(submenu.length, 5, 'capped');
    assert.deepEqual(submenu[0].action, { kind: 'open-workspace', root: '/Users/me/code/proj-0' });
    assert.equal(submenu[0].label, '…/code/proj-0');
});
