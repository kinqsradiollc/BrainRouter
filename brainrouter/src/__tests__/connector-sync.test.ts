import { describe, expect, it } from "vitest";
import type { IMemoryStore, MemoryJobRecord } from "@kinqs/brainrouter-types";
import type { ConnectorConfigRecord } from "../connectors/store.js";
import { enqueueConnectorSyncs } from "../connectors/syncExecutor.js";

function connector(id: string, userId: string): ConnectorConfigRecord {
  return {
    id,
    userId,
    orgId: "org_1",
    source: "slack",
    name: id,
    status: "connected",
    enabled: true,
    visibility: "org",
    config: {},
    hasCredential: true,
    checkpoint: {},
    lastRunAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("connector sync scheduler", () => {
  it("enqueues every enabled connector except one already pending or running", async () => {
    const enqueued: Array<{ kind: string; input: unknown }> = [];
    const active = {
      id: "job_active",
      kind: "connector_sync",
      status: "pending",
      input: { connectorId: "conn_active", userId: "u1" },
    } as MemoryJobRecord;
    const store = {
      async listMemoryJobs() { return [active]; },
      async enqueueMemoryJob(input: { kind: string; input: unknown }) {
        enqueued.push(input);
        return { ...active, id: `job_${enqueued.length}`, kind: input.kind, input: input.input };
      },
    } as unknown as IMemoryStore;
    const connectorStore = {
      async listAllEnabledConnectors() {
        return [connector("conn_active", "u1"), connector("conn_new", "u2")];
      },
    };

    await expect(enqueueConnectorSyncs(store, connectorStore)).resolves.toBe(1);
    // ADR-027 D12 — the scheduler still skips in-flight connectors itself (it
    // lists them above), and now ALSO passes the agent's idempotency key so the
    // partial unique index is a second line of defence against a duplicate
    // slipping through the gap between the list and the insert.
    expect(enqueued).toEqual([{
      kind: "connector_sync",
      input: { connectorId: "conn_new", userId: "u2" },
      priority: undefined,
      maxAttempts: 3,
      idempotencyKey: "connector:conn_new",
    }]);
  });
});
