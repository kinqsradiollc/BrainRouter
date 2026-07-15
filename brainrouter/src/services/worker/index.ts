/**
 * Worker/Jobs microservice entry (ADR-011). Boots a MemoryEngine with the job
 * runner ON and NO HTTP server — it just drains the shared memory_jobs queue as
 * a competing consumer (the claim is atomic, so N workers are safe). The brain
 * runs with BRAINROUTER_JOB_RUNNER=off and delegates async work here.
 *
 *   node dist/services/worker/index.js
 */
import { MemoryEngine } from "../../memory/engine.js";
import { rm, writeFile } from "node:fs/promises";

const READY_FILE = process.env.BRAINROUTER_WORKER_READY_FILE ?? "/tmp/brainrouter-worker-ready";

async function main(): Promise<void> {
  await rm(READY_FILE, { force: true });
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
  await writeFile(READY_FILE, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  console.error("[worker] ready — draining memory_jobs");

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await rm(READY_FILE, { force: true }).catch(() => undefined);
    try { await engine.close(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep the process alive; the engine's internal job runner drains on its timer.
  setInterval(() => { /* heartbeat */ }, 1 << 30);
}

main().catch((e) => { console.error("[worker] fatal:", e); process.exit(1); });
