import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV,
  searchSettings,
  settingsGroupForSection,
  settingsSectionForGroup,
} from './types.js';

test('settings navigation keeps every section id unique', () => {
  const sections = NAV.map((item) => item.section);
  assert.equal(new Set(sections).size, sections.length);
  assert.deepEqual(sections, [
    'account',
    'general',
    'models',
    'permissions',
    'memory',
    'tools',
    'workflow-automation',
    'runtime',
    'automations',
    'reviews',
    'hooks',
    'connectors',
    'data-connectors',
    'repositories',
    'extensions',
    'marketplace',
    'observability',
    'appearance',
    'commands',
    'advanced',
  ]);
});

test('settings search finds pages through control-level aliases', () => {
  assert.deepEqual(searchSettings('sandbox').map((item) => item.section), ['permissions']);
  assert.ok(searchSettings('/fast').some((item) => item.section === 'general'));
  assert.ok(searchSettings('oauth client').some((item) => item.section === 'advanced'));
  assert.ok(searchSettings('transcript width').some((item) => item.section === 'appearance'));
  assert.deepEqual(searchSettings('Desktop theme').map((item) => item.section), ['appearance']);
  assert.deepEqual(searchSettings('Vi composer').map((item) => item.section), ['appearance']);
  assert.deepEqual(searchSettings('does-not-exist'), []);
});

test('category navigation restores a valid remembered subsection', () => {
  assert.equal(settingsGroupForSection('memory'), 'Agent');
  assert.equal(settingsGroupForSection('general'), 'Agent');
  assert.equal(settingsSectionForGroup('Agent', 'memory'), 'memory');
  assert.equal(settingsSectionForGroup('Agent', 'appearance'), 'general');
  assert.equal(settingsSectionForGroup('Connections'), 'connectors');
});
