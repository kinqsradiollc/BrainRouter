import { MemoryEngine } from "../src/memory/engine.js";
import { extractL1Memories } from "../src/memory/pipeline/l1-extractor.js";
import { deduplicateMemories } from "../src/memory/pipeline/l1-dedup.js";
import { detectContradictions } from "../src/memory/pipeline/l1-contradiction.js";
import "dotenv/config";

async function recover() {
  const engine = new MemoryEngine();
  // @ts-ignore
  const store = engine.store;
  // @ts-ignore
  const llmRunner = engine.llmRunner;
  // @ts-ignore
  const embeddingService = engine.capturePipeline.embeddingService;

  const userId = "anhdang";
  const sessionKey = "82640dae-60bc-446a-b96e-401f47962b97";

  console.log(`Checking unextracted L0 messages for ${userId} in ${sessionKey}...`);
  
  // Retrieve ALL L0 messages for this user/session in chronological order (oldest first)
  // @ts-ignore
  const db = store.db;
  const allL0 = db.prepare("SELECT record_id as id, user_id as userId, session_key as sessionKey, session_id as sessionId, role, message_text as messageText, recorded_at as recordedAt, timestamp, skill_tag as skillTag FROM l0_conversations WHERE user_id = ? AND session_key = ? ORDER BY recorded_at ASC").all(userId, sessionKey) as any[];

  console.log(`Found total ${allL0.length} L0 messages in active session.`);

  if (allL0.length === 0) {
    console.log("No messages found in backlog. Exiting.");
    return;
  }

  // Batch them in chunks of 10 messages for extraction
  const chunkSize = 10;
  let processedCount = 0;

  for (let i = 0; i < allL0.length; i += chunkSize) {
    const chunk = allL0.slice(i, i + chunkSize);
    console.log(`\n--- Extracting batch ${Math.floor(i / chunkSize) + 1} (${chunk.length} messages) ---`);

    const extractionResult = await extractL1Memories({
      messages: chunk,
      userId,
      sessionKey,
      sessionId: chunk[0].sessionId || "",
      llmRunner,
      activeSkill: "UI/UX Design"
    });

    if (extractionResult.success && extractionResult.records.length > 0) {
      console.log(`Extracted ${extractionResult.records.length} potential memories. Deduplicating...`);
      
      const { uniqueRecords, droppedCount } = await deduplicateMemories({
        records: extractionResult.records,
        store,
        userId
      });

      console.log(`Deduplicated: Storing ${uniqueRecords.length} unique memories (dropped ${droppedCount} duplicates).`);

      for (const record of uniqueRecords) {
        store.upsertL1(record);

        if (embeddingService.isReady()) {
          try {
            const vec = await embeddingService.embed(record.content);
            store.upsertL1Vec(record.id, vec);
          } catch (err: any) {
            console.error(`Failed to embed: ${err.message}`);
          }
        }

        await detectContradictions({
          newRecord: record,
          store,
          llmRunner
        }).catch(err => console.error("Contradiction check err:", err.message));
      }
      
      processedCount += uniqueRecords.length;
    } else {
      console.log("No memories extracted or extraction failed in this batch.");
    }
  }

  console.log(`\n🎉 Backlog recovery complete! Distilled ${processedCount} long-term L1 memories.`);
}

recover().catch(console.error);
