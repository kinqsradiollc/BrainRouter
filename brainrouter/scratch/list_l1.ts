import { SqliteMemoryStore } from "../src/memory/store/sqlite.js";
import path from "node:path";
import os from "node:os";

async function listAllL1() {
  const dbPath = process.env.BRAINROUTER_MEMORY_DB || path.join(os.homedir(), ".brainrouter", "memory.db");
  console.log("Reading DB:", dbPath);
  const store = new SqliteMemoryStore(dbPath);
  store.init();

  // @ts-ignore
  const db = store.db;
  const rows = db.prepare("SELECT * FROM l1_records").all();
  console.log(`Found ${rows.length} L1 memories:`);
  console.log(JSON.stringify(rows, null, 2));
}

listAllL1();
