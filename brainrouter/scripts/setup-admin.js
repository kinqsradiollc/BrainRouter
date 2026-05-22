#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function parseArgs(argv) {
  const args = { reset: false, userId: "admin" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") args.reset = true;
    else if (a === "--email") args.email = argv[++i];
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--userId") args.userId = argv[++i];
  }
  return args;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL UNIQUE,
      password_hash TEXT DEFAULT NULL,
      display_name TEXT DEFAULT '',
      email TEXT DEFAULT '',
      is_admin INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      invite_token TEXT DEFAULT NULL,
      created_at TEXT NOT NULL
    )
  `);
  for (const sql of [
    "ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'",
    "ALTER TABLE users ADD COLUMN invite_token TEXT DEFAULT NULL",
  ]) {
    try { db.exec(sql); } catch {}
  }
}

function main() {
  const args = parseArgs(process.argv);
  const userId = (args.userId || "admin").trim();
  const email = (args.email || process.env.BRAINROUTER_ADMIN_EMAIL || "admin").trim();
  const password = (args.password || process.env.BRAINROUTER_ADMIN_PASSWORD || "").trim();
  const dbPath = process.env.BRAINROUTER_MEMORY_DB || path.join(os.homedir(), ".brainrouter", "memory.db");

  if (!userId) {
    console.error("[BrainRouter] --userId cannot be empty");
    process.exit(1);
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  ensureSchema(db);

  const current = db.prepare("SELECT user_id, email FROM users WHERE user_id = ?").get(userId);
  const apiKey = `br_${randomBytes(24).toString("hex")}`;
  const now = new Date().toISOString();

  if (!current) {
    db.prepare(`
      INSERT INTO users (user_id, api_key, password_hash, display_name, email, is_admin, status, invite_token, created_at)
      VALUES (?, ?, ?, ?, ?, 1, 'active', NULL, ?)
    `).run(userId, apiKey, password ? hashPassword(password) : null, "Admin", email, now);
  } else if (args.reset) {
    db.prepare("UPDATE users SET api_key = ?, is_admin = 1, status = 'active', email = ? WHERE user_id = ?").run(apiKey, email, userId);
    if (password) {
      db.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?").run(hashPassword(password), userId);
    }
  }

  const final = db.prepare("SELECT user_id, email, api_key FROM users WHERE user_id = ?").get(userId);
  console.log(`[BrainRouter] Admin ready. Email: ${final.email || email}`);
  console.log(`[BrainRouter] API key: ${final.api_key}`);
}

try {
  main();
} catch (error) {
  console.error("[BrainRouter] setup-admin failed", error);
  process.exit(1);
}
