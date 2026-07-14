/**
 * Remote-relay entry point (spec §9, Task 22). Run as its own process:
 *   node dist/services/remoteRelay/index.js
 * Deployed via deploy/stack alongside API/gateway/worker. Validates single-use
 * tickets against the shared PostgreSQL control plane and splices opaque E2EE
 * frames — it never resolves providers, decrypts payloads, or persists content.
 */
import { PostgresMemoryStore } from "../../memory/store/postgres/PostgresMemoryStore.js";
import type { RemoteAccessStore } from "../../remote/store.js";
import { RemoteControlPlaneService } from "./tickets.js";
import { RemoteRelayServer } from "./server.js";

async function main(): Promise<void> {
  const url = process.env.BRAINROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("[remote-relay] BRAINROUTER_DATABASE_URL (or DATABASE_URL) is required");
    process.exit(1);
  }
  const port = parseInt(process.env.REMOTE_RELAY_PORT ?? "3749", 10);
  const store = new PostgresMemoryStore(url);
  const controlPlane = new RemoteControlPlaneService(store as unknown as RemoteAccessStore);
  const server = new RemoteRelayServer({
    controlPlane,
    ping: () => store.ping(),
  });
  const bound = await server.listen(port);
  console.error(`[remote-relay] listening on :${bound}`);

  const shutdown = () => {
    void server.close().then(() => store.close()).finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
