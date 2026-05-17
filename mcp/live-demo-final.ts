import { memoryEngine } from "./src/memory/engine.js";

async function runDemo() {
  const userId = "demo_user_" + Math.floor(Math.random() * 10000);
  const sessionKey = "architect_session";

  console.log("🚀 STARTING BRAINROUTER MEMORY SHOWCASE\n");

  // --- STAGE 1: EPISODIC SEEDING ---
  console.log("📦 Stage 1: Capturing User Context & Technical Mandates...");
  await memoryEngine.capture({
    userId,
    sessionKey,
    messages: [
      { role: "user", content: "I'm the lead engineer for the Kinqs Radio project. We are migrating to a monorepo structure. I want to use Turborepo and pnpm. This is a non-negotiable architectural decision.", timestamp: Date.now() },
      { role: "assistant", content: "Got it. I've recorded the mandate for Turborepo and pnpm for the Kinqs Radio monorepo migration. I will ensure all future workspace configurations align with this.", timestamp: Date.now() }
    ]
  });

  // --- STAGE 2: PREFERENCE SEEDING ---
  console.log("🎨 Stage 2: Capturing Design Taste & Workflow...");
  await memoryEngine.capture({
    userId,
    sessionKey,
    messages: [
      { role: "user", content: "For our UI, I hate generic 'Material' looks. We want a premium, high-contrast dark mode with glassmorphism effects. Also, always use Lucide icons for consistency.", timestamp: Date.now() },
      { role: "assistant", content: "Understood. I have noted your preference for glassmorphism and high-contrast dark mode, avoiding Material Design defaults. I'll use Lucide icons for all UI components.", timestamp: Date.now() }
    ]
  });

  // --- STAGE 3: CONTRADICTION SEEDING ---
  console.log("⚠️ Stage 3: Triggering Conflict Detection (L1.5)...");
  await memoryEngine.capture({
    userId,
    sessionKey,
    messages: [
      { role: "user", content: "Actually, let's just use regular npm for the monorepo, it's easier for the juniors.", timestamp: Date.now() },
      { role: "assistant", content: "Wait, didn't we just decide on pnpm? I'll record this change, but I'll flag it as a potential conflict with our earlier 'non-negotiable' decision.", timestamp: Date.now() }
    ]
  });

  console.log("\n⏳ Waiting for Background Pipelines (L1 Extraction, L1.5 Contradiction, L2 Scenes)...");
  await new Promise(r => setTimeout(r, 15000));

  // Trigger L2/L3 manually for the demo
  console.log("\n⚡ Manually Distilling Narrative Layers (L2 & L3)...");
  await memoryEngine.distillScenes(userId);
  await memoryEngine.distillPersona(userId);

  // --- STAGE 4: RECALL & SHOWCASE ---
  console.log("\n🔍 Stage 4: Performing High-Agency Recall...");
  const recall = await memoryEngine.recall({
    userId,
    sessionKey,
    query: "What are our monorepo and UI standards? And are there any pending conflicts?",
  });

  console.log("\n==================================================");
  console.log("🧠 BRAINROUTER AGENT CONTEXT");
  console.log("==================================================");

  console.log("\n👤 [L3 USER PERSONA]");
  console.log(recall.personaSummary || "Persona distillation still in progress...");

  console.log("\n🎬 [L2 ACTIVE SCENES & KNOWLEDGE GRAPH]");
  console.log(recall.appendSystemContext || "No system context.");

  console.log("\n🕸️ [KNOWLEDGE GRAPH DIRECT QUERY - 'Lucide icons']");
  const graphResult = memoryEngine.queryGraph(userId, "Lucide icons");
  console.log(JSON.stringify(graphResult, null, 2));

  console.log("\n💾 [L1 RELEVANT MEMORIES]");
  console.log(recall.prependContext);

  console.log("\n🛑 [L1.5 CONFLICTS]");
  const contradictions = memoryEngine.getPendingContradictions(userId);
  if (contradictions.length > 0) {
    contradictions.forEach((c: any, i: number) => {
      console.log(`Conflict #${i + 1}:`);
      console.log(`  - Reason: ${c.reason}`);
      console.log(`  - Record A: "${c.content_a.slice(0, 60)}..."`);
      console.log(`  - Record B: "${c.content_b.slice(0, 60)}..."`);
      console.log(`  - Confidence: ${c.confidence.toFixed(2)}`);
    });
  } else {
    console.log("No pending conflicts detected.");
  }

  // ── PHASE 3 FEATURE DEMOS ───────────────────────────────────────────────

  console.log("\n==================================================");
  console.log("🆕 PHASE 3: ACE FEEDBACK LOOP DEMO");
  console.log("==================================================");

  const recalledIds = (recall.recalledL1Memories ?? []).map((m: any) => m.recordId);
  if (recalledIds.length > 0) {
    // Simulate: agent used the first memory, ignored the rest
    const cited = [recalledIds[0]];
    const aceResult = memoryEngine.markCited(userId, cited, recalledIds);
    console.log("\n✅ [memory_mark_cited] Called after response generation:");
    console.log(`  - Cited:          ${aceResult.cited} memory  (citation_count++ + never_cited reset)`);
    console.log(`  - Not cited:      ${aceResult.nonCited} memories (never_cited_count++)`);
    console.log(`  - Archive threshold: ${aceResult.archiveThreshold === 0 ? "disabled" : aceResult.archiveThreshold}`);

    // Second recall to prove citation boost is applied
    const recall2 = await memoryEngine.recall({ userId, sessionKey, query: "monorepo UI standards" });
    const topMemory = recall2.recalledL1Memories?.[0];
    console.log(`\n  ↑ Re-recalled top memory after citation boost:`);
    console.log(`    "${topMemory?.content?.slice(0, 80)}..."`);
    console.log(`    score: ${topMemory?.score?.toFixed(4)}`);
  } else {
    console.log("  (No recalled memories to cite — skip ACE demo)");
  }

  console.log("\n==================================================");
  console.log("⏱️  PHASE 3: POINT-IN-TIME RECALL (asOf) DEMO");
  console.log("==================================================");

  // asOf set to 1 minute ago — should still catch memories captured in this demo
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
  const asOfResult = memoryEngine.searchAsOf(userId, "monorepo pnpm turborepo", oneMinAgo, 5);
  console.log(`\n🔎 Memories valid at ${oneMinAgo}:`);
  if (asOfResult.count > 0) {
    asOfResult.memories.forEach((m: any, i: number) => {
      console.log(`  ${i + 1}. [${m.type}] ${m.content.slice(0, 90)}`);
    });
  } else {
    console.log("  No memories found at that timestamp.");
  }

  // asOf set far in the past — should return nothing
  const wayBack = "2020-01-01T00:00:00.000Z";
  const asOfOld = memoryEngine.searchAsOf(userId, "monorepo", wayBack, 5);
  console.log(`\n🔎 Memories valid at ${wayBack} (expect 0): count=${asOfOld.count}`);

  console.log("\n==================================================");
  console.log("⚙️  PHASE 3: MODEL ROUTING CONFIRMATION");
  console.log("==================================================");
  const extractionModel = process.env.BRAINROUTER_EXTRACTION_MODEL || process.env.BRAINROUTER_LLM_MODEL || "gpt-4o-mini (default)";
  const synthesisModel  = process.env.BRAINROUTER_SYNTHESIS_MODEL  || process.env.BRAINROUTER_LLM_MODEL || "gpt-4o-mini (default)";
  console.log(`  Extraction runner: ${extractionModel}`);
  console.log(`  Synthesis runner:  ${synthesisModel}`);

  console.log("\n==================================================");
  console.log("✅ DEMO COMPLETE: The Brain is fully synchronized.");
}

runDemo().catch(console.error);
