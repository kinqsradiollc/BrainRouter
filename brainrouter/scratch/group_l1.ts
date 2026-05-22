import { SqliteMemoryStore } from "../src/memory/store/sqlite.js";
import path from "node:path";
import os from "node:os";

async function groupL1() {
  const dbPath = process.env.BRAINROUTER_MEMORY_DB || path.join(os.homedir(), ".brainrouter", "memory.db");
  console.log("Reading DB:", dbPath);
  const store = new SqliteMemoryStore(dbPath);
  store.init();

  // @ts-ignore
  const db = store.db;
  const rows = db.prepare("SELECT user_id, session_key, COUNT(*) as count FROM l1_records GROUP BY user_id, session_key").all();
  console.log("L1 Records Summary:");
  console.log(JSON.stringify(rows, null, 2));

  const l0Rows = db.prepare("SELECT user_id, session_key, COUNT(*) as count FROM l0_conversations GROUP BY user_id, session_key").all();
  console.log("L0 Conversations Summary:");
  console.log(JSON.stringify(l0Rows, null, 2));
}

groupL1();
