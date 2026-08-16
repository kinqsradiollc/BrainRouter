/**
 * ADR-034 schema parity regression: SQL lifecycle states and delivery bounds
 * must match the shared TypeScript contract exactly.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_SESSION_CLAIM_LEASE_MS,
  SESSION_MESSAGE_MAX_FANOUT,
  SESSION_MESSAGE_MAX_PENDING_PER_RECIPIENT,
  SESSION_MESSAGE_NOTIFICATION_CHANNEL,
  SESSION_MESSAGE_PENDING_TTL_MS,
  SESSION_MESSAGE_STATUSES,
  SESSION_MESSAGE_TERMINAL_RETENTION_MS,
} from "@kinqs/brainrouter-types";

const SQL = readFileSync(
  new URL("./migrations/058_session_message_delivery.sql", import.meta.url),
  "utf8",
).replace(/^\s*--.*$/gm, "");

describe("session message delivery schema", () => {
  it("keeps the SQL status constraint in exact parity with shared types", () => {
    const match = /session_inbox_status_check[\s\S]*?CHECK\s*\([\s\S]*?IN\s*\(([\s\S]*?)\)/i.exec(SQL);
    expect(match, "session_inbox_status_check not found").not.toBeNull();
    const admitted = [...match![1]!.matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    expect(admitted).toEqual([...SESSION_MESSAGE_STATUSES]);
  });

  it("pins the accepted lifecycle limits", () => {
    expect(ACTIVE_SESSION_CLAIM_LEASE_MS).toBe(2 * 60 * 1000);
    expect(SESSION_MESSAGE_PENDING_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(SESSION_MESSAGE_TERMINAL_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(SESSION_MESSAGE_MAX_PENDING_PER_RECIPIENT).toBe(100);
    expect(SESSION_MESSAGE_MAX_FANOUT).toBe(100);
    expect(SQL).toContain("interval '24 hours'");
    expect(SQL).toContain("interval '2 minutes'");
  });

  it("uses tenant-scoped keys and a bounded notification channel", () => {
    expect(SQL).toMatch(/PRIMARY KEY \(org_id, user_id, session_key\)/);
    expect(SQL).toMatch(/claim_token[\s\S]*?SET NOT NULL/);
    expect(SQL).toMatch(/claim_expires_at[\s\S]*?SET NOT NULL/);
    expect(SQL).toMatch(/PRIMARY KEY \(org_id, user_id, from_session_key, message_id\)/);
    expect(Buffer.byteLength(SESSION_MESSAGE_NOTIFICATION_CHANNEL, "utf8")).toBeLessThanOrEqual(63);
  });
});
