import test from 'node:test';
import assert from 'node:assert/strict';
import { pgUrlFromEnv, isPostgresConfigured } from '../memory/store/postgres/connection.js';
import { orderMigrations } from '../memory/store/postgres/migrate.js';

test('pgUrlFromEnv: reads BRAINROUTER_DATABASE_URL / DATABASE_URL, trims, prefers the former', () => {
  assert.equal(pgUrlFromEnv({}), undefined);
  assert.equal(isPostgresConfigured({}), false);
  assert.equal(pgUrlFromEnv({ BRAINROUTER_DATABASE_URL: 'postgres://a' }), 'postgres://a');
  assert.equal(pgUrlFromEnv({ DATABASE_URL: 'postgres://b' }), 'postgres://b');
  assert.equal(pgUrlFromEnv({ BRAINROUTER_DATABASE_URL: 'postgres://a', DATABASE_URL: 'postgres://b' }), 'postgres://a');
  assert.equal(pgUrlFromEnv({ BRAINROUTER_DATABASE_URL: '   ' }), undefined);
  assert.equal(isPostgresConfigured({ DATABASE_URL: 'postgres://b' }), true);
});

test('orderMigrations: numeric-prefix order, drops non-.sql', () => {
  assert.deepEqual(
    orderMigrations(['010_late.sql', '002_second.sql', '001_init.sql', 'notes.md', '003_third.sql']),
    ['001_init.sql', '002_second.sql', '003_third.sql', '010_late.sql'],
  );
  assert.deepEqual(orderMigrations([]), []);
});
