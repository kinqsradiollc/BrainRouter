/**
 * Worker/Jobs microservice entry (ADR-011). Boots a MemoryEngine with the job
 * runner ON and NO HTTP server — it just drains the shared memory_jobs queue as
 * a competing consumer (the claim is atomic, so N workers are safe). The brain
 * runs with BRAINROUTER_JOB_RUNNER=off and delegates async work here.
 *
 *   node dist/services/worker/index.js
 */
import { MemoryEngine } from "../../memory/engine.js";

async function main(): Promise<void> {
  if (!process.env.BRAINROUTER_DATABASE_URL && !process.env.DATABASE_URL) {
    console.error("[worker] BRAINROUTER_DATABASE_URL (or DATABASE_URL) is required");
    process.exit(1);
  }
  // The worker's whole purpose is to drain jobs — never let an inherited
  // BRAINROUTER_JOB_RUNNER=off (the brain's setting) disable it here.
  if ((process.env.BRAINROUTER_JOB_RUNNER ?? "").toLowerCase() === "off") {
    delete process.env.BRAINROUTER_JOB_RUNNER;
  }

  const engine = new MemoryEngine();
  await engine.ready;
  console.error("[worker] ready — draining memory_jobs");

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try { await engine.close(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep the process alive; the engine's internal job runner drains on its timer.
  setInterval(() => { /* heartbeat */ }, 1 << 30);
}

main().catch((e) => { console.error("[worker] fatal:", e); process.exit(1); });
