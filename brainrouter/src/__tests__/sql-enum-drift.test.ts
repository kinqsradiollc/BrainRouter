/**
 * ADR-046 D1 (SQL case) — enum CHECK constraint ↔ TS union drift gate.
 *
 * A migration CHECK constraint and its exported TypeScript union are maintained
 * by hand in parallel. In-memory test stores enforce no CHECK, so a divergence
 * is invisible until real Postgres rejects a row CI accepted. This gate harvests
 * the CHECK's value set straight from the migration SQL and asserts it is
 * identical to the exported runtime array the union is derived from.
 *
 * Adding a pair: export an `as const` array next to the union (so it has a
 * runtime representation), then add one PAIRS entry naming the migration file
 * and constraint. Type-only unions cannot be enumerated at runtime and are not
 * eligible — give them a runtime array first.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SESSION_MESSAGE_STATUSES } from '@kinqs/brainrouter-types';

interface EnumPair {
  id: string;
  /** The exported runtime array the TS union is derived from. */
  tsValues: readonly string[];
  /** Migration file under src/memory/store/postgres/migrations. */
  migrationFile: string;
  /** The named CHECK constraint whose IN(...) set is authoritative. */
  constraint: string;
}

const PAIRS: EnumPair[] = [
  {
    id: 'session_inbox.status ↔ SESSION_MESSAGE_STATUSES',
    tsValues: SESSION_MESSAGE_STATUSES,
    migrationFile: '058_session_message_delivery.sql',
    constraint: 'session_inbox_status_check',
  },
];

const migrationsDir = fileURLToPath(new URL('../memory/store/postgres/migrations/', import.meta.url));

/** Pull the quoted value set from the first `IN (...)` after the named constraint. */
function checkSetForConstraint(sql: string, constraint: string): string[] {
  const at = sql.indexOf(constraint);
  if (at < 0) throw new Error(`constraint "${constraint}" not found in migration`);
  const after = sql.slice(at);
  const inMatch = after.match(/IN\s*\(([^)]*)\)/i);
  if (!inMatch) throw new Error(`no IN(...) clause found after constraint "${constraint}"`);
  return [...inMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('ADR-046 D1 — SQL enum CHECK ↔ TS union drift', () => {
  for (const pair of PAIRS) {
    it(`${pair.id} are identical sets`, () => {
      const sql = fs.readFileSync(migrationsDir + pair.migrationFile, 'utf8');
      const sqlSet = [...checkSetForConstraint(sql, pair.constraint)].sort();
      const tsSet = [...pair.tsValues].sort();
      expect(sqlSet).toEqual(tsSet);
    });
  }

  it('the extractor actually catches an injected divergence (the gate works)', () => {
    const sql = "ADD CONSTRAINT c CHECK (x IN ('a', 'b', 'c'));";
    const set = checkSetForConstraint(sql, 'c').sort();
    // A TS union missing 'c' must NOT compare equal — proving the gate can fail.
    expect(set).not.toEqual(['a', 'b']);
    expect(set).toEqual(['a', 'b', 'c']);
  });
});
