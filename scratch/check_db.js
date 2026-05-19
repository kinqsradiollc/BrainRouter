import sqlite from 'node:sqlite';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.homedir(), '.brainrouter', 'memory.db');
const db = new sqlite.DatabaseSync(dbPath);

console.log('\n--- L0 CONVERSATIONS BY USER ---');
try {
  const counts = db.prepare('SELECT user_id, COUNT(*) as count FROM l0_conversations GROUP BY user_id').all();
  console.log(counts);

  const samples = db.prepare('SELECT user_id, session_key, role, recorded_at FROM l0_conversations LIMIT 5').all();
  console.log('Sample conversations:', samples);
} catch (e) {
  console.error(e);
}
