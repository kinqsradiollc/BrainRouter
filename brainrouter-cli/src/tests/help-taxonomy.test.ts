import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP_CATEGORIES, SLASH_COMMANDS } from '../cli/repl.js';

/**
 * Invocation signature: the leading `/command` plus any following LITERAL
 * subcommand words (stop at the first placeholder `<..>` / `[..]` or `-flag`).
 * So `/agents tree` and `/agents [--json]` are distinct (a subcommand vs the
 * base), but `/model [name]` and `/model <name>` collide — a true duplicate row.
 */
function helpSignature(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  if (!tokens[0]?.startsWith('/')) return cmd.trim();
  const sig = [tokens[0]];
  for (const t of tokens.slice(1)) {
    if (/^[a-z]/i.test(t)) { sig.push(t.replace(/[|,]/g, '')); continue; } // literal subcommand word
    if (/^--[a-z]/i.test(t)) { sig.push(t); continue; } // bare mode flag (e.g. --remote) distinguishes a mode
    break; // bracketed placeholder/optional (`[--json]`, `<id>`), pipe, slash → end of signature
  }
  return sig.join(' ');
}

function baseCommands(cmd: string): string[] {
  return cmd.match(/\/[a-z][a-z0-9-]*/gi) ?? [];
}

test('CLI-12 help taxonomy: no duplicate help rows for the same invocation', () => {
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const cat of HELP_CATEGORIES) {
    for (const entry of cat.entries) {
      const sig = helpSignature(entry.cmd);
      const prior = seen.get(sig);
      if (prior && prior !== entry.cmd) dups.push(`${sig}: "${prior}" vs "${entry.cmd}"`);
      else if (!prior) seen.set(sig, entry.cmd);
    }
  }
  assert.deepEqual(dups, [], `duplicate help rows: ${dups.join('; ')}`);
});

test('CLI-12 help taxonomy: every documented command is a registered SLASH_COMMAND', () => {
  const registered = new Set<string>(SLASH_COMMANDS as readonly string[]);
  const orphans: string[] = [];
  for (const cat of HELP_CATEGORIES) {
    for (const entry of cat.entries) {
      // skip `!` shell escape / bare `?` (documented but not slash commands)
      for (const cmdTok of baseCommands(entry.cmd)) {
        if (!registered.has(cmdTok)) orphans.push(`${cmdTok} (in "${entry.cmd}")`);
      }
    }
  }
  assert.deepEqual(orphans, [], `help references unregistered commands: ${orphans.join('; ')}`);
});
