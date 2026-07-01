import { after } from "node:test";
import { closeMemoryEngine } from "../../memory/engine.js";

/**
 * Global node:test teardown (wired via `node --test --import …`). If a test
 * constructed the lazy `memoryEngine` singleton, close it so its Postgres pool
 * releases and the process exits cleanly — no `--test-force-exit` needed.
 * Scratch stores/engines (createTestStore/createTestEngine) close themselves in
 * their own `cleanup()`, so this only handles the shared singleton. No-op when
 * it was never built.
 */
after(async () => {
  await closeMemoryEngine();
});
