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

  console.log("\n🎬 [L2 ACTIVE SCENES]");
  const sceneNav = recall.appendSystemContext?.match(/<scene-navigation>([\s\S]*?)<\/scene-navigation>/)?.[1];
  console.log(sceneNav?.trim() || "No scenes active.");

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

  console.log("\n==================================================");
  console.log("✅ DEMO COMPLETE: The Brain is fully synchronized.");
}

runDemo().catch(console.error);
