import test from 'node:test';
import assert from 'node:assert/strict';

import { SLASH_COMMANDS, HELP_CATEGORIES } from '../cli/repl.js';
import {
  helpEntryTokens,
  helpPrimaryCommands,
  helpEntryRows,
  findDuplicates,
  registryDrift,
} from '@kinqs/brainrouter-core/dist/command/registry.js';


// --- pure helpers ----------------------------------------------------------

test('helpEntryTokens extracts slash tokens, drops arg hints + non-slash', () => {
  assert.deepEqual(helpEntryTokens('/config [key] [value]'), ['/config']);
  assert.deepEqual(helpEntryTokens('/side <q>  /btw <q>'), ['/side', '/btw']);
  assert.deepEqual(helpEntryTokens('! <command>'), []);
});

test('findDuplicates returns only the repeated names', () => {
  assert.deepEqual(findDuplicates(['/a', '/b', '/a', '/c', '/c']), ['/a', '/c']);
  assert.deepEqual(findDuplicates(['/a', '/b']), []);
});

// --- registry invariants (CMD-REGISTRY) ------------------------------------

test('CMD-REGISTRY: no duplicate rows in the slash-command list', () => {
  assert.deepEqual(findDuplicates(SLASH_COMMANDS), [], 'SLASH_COMMANDS has duplicate entries');
});

test('CMD-REGISTRY: no duplicate rows in /help (identical cmd documented twice)', () => {
  // Subcommands legitimately share a primary token (/brain run, /agents tree),
  // so we dedupe on the full cmd string, not the token.
  assert.deepEqual(findDuplicates(helpEntryRows(HELP_CATEGORIES)), [], 'HELP_CATEGORIES has an identical row twice');
});

test('CMD-REGISTRY: completion list and /help stay in lockstep (no drift)', () => {
  const drift = registryDrift(SLASH_COMMANDS, helpPrimaryCommands(HELP_CATEGORIES));
  assert.deepEqual(drift.inHelpNotSlash, [], 'documented in /help but missing from SLASH_COMMANDS (tab-completion)');
  assert.deepEqual(drift.inSlashNotHelp, [], 'in SLASH_COMMANDS but undocumented in /help');
});
