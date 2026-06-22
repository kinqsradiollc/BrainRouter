import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandService, CommandService } from '../command/service.js';
import {
  helpEntryTokens, helpCommandTokens, helpPrimaryCommands, helpEntryRows,
  findDuplicates, registryDrift, type HelpCategoryLike,
} from '../command/registry.js';

test('CommandService is a stateless facade — delegates to the command registry helpers', () => {
  const svc = createCommandService();
  assert.ok(svc instanceof CommandService);

  assert.deepEqual(svc.entryTokens('/foo <x> /bar'), helpEntryTokens('/foo <x> /bar'));
  assert.deepEqual(svc.findDuplicates(['a', 'b', 'a']), findDuplicates(['a', 'b', 'a']));

  const cats: HelpCategoryLike[] = [
    { entries: [{ cmd: '/foo <x>', desc: 'foo' }, { cmd: '/bar', desc: 'bar' }] },
  ];
  assert.deepEqual(svc.commandTokens(cats), helpCommandTokens(cats));
  assert.deepEqual(svc.primaryCommands(cats), helpPrimaryCommands(cats));
  assert.deepEqual(svc.entryRows(cats), helpEntryRows(cats));
  assert.deepEqual(svc.registryDrift(['/a', '/b'], ['/a', '/c']), registryDrift(['/a', '/b'], ['/a', '/c']));
});
