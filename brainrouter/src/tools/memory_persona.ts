import { z } from "zod";
import { createHash } from "crypto";
import { memoryEngine } from "../memory/engine.js";

function personaHash(personaMd: string | undefined | null): string {
  if (!personaMd) return "";
  return createHash("sha256").update(personaMd).digest("hex").slice(0, 16);
}

function toolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export const memoryPersonaToolSchema = {
  name: "memory_persona",
  description:
    "Read the active Core Identity (durable persona Markdown) for a user. Returns personaMd, content hash, generation count, and last-updated timestamp. Use this to inject persona into a session prefix so the agent knows who the user is.",
  inputSchema: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "User id (multi-tenant isolation). Falls back to the default user when omitted.",
      },
    },
  },
} as const;

const memoryPersonaSchema = z.object({
  userId: z.string().optional(),
});

export async function handleMemoryPersona(args: any, options?: { defaultUserId?: string }) {
  const { userId } = memoryPersonaSchema.parse(args ?? {});
  const effectiveUserId = userId ?? options?.defaultUserId ?? "default";

  const persona = memoryEngine.getPersona(effectiveUserId);
  if (!persona) {
    return toolResult({
      userId: effectiveUserId,
      personaMd: null,
      hash: "",
      cognitiveCountAtGeneration: 0,
      updatedTime: null,
      createdTime: null,
      reason: "no Core Identity yet — call memory_persona_refresh to distill one",
    });
  }

  // memoryEngine.getPersona may return either the lightweight cache shape
  // ({ personaMd }) or the full store record. Coerce to the union shape.
  const record = persona as {
    personaMd: string;
    cognitiveCountAtGeneration?: number;
    createdTime?: string;
    updatedTime?: string;
  };

  return toolResult({
    userId: effectiveUserId,
    personaMd: record.personaMd,
    hash: personaHash(record.personaMd),
    cognitiveCountAtGeneration: record.cognitiveCountAtGeneration ?? null,
    createdTime: record.createdTime ?? null,
    updatedTime: record.updatedTime ?? null,
  });
}

export const memoryPersonaRefreshToolSchema = {
  name: "memory_persona_refresh",
  description:
    "Trigger a fresh Core Identity distillation pass for the user (synthesizes all persona/instruction cognitives via the brain's synthesis LLM). Returns the new persona, hash, and cognitive count. Idempotent — safe to call again.",
  inputSchema: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "User id (multi-tenant isolation). Falls back to the default user when omitted.",
      },
    },
  },
} as const;

const memoryPersonaRefreshSchema = z.object({
  userId: z.string().optional(),
});

export async function handleMemoryPersonaRefresh(args: any, options?: { defaultUserId?: string }) {
  const { userId } = memoryPersonaRefreshSchema.parse(args ?? {});
  const effectiveUserId = userId ?? options?.defaultUserId ?? "default";

  const result = await memoryEngine.distillPersona(effectiveUserId);
  if (!result.success || !result.personaMd) {
    return toolResult({
      userId: effectiveUserId,
      status: "skipped",
      reason:
        "distillation did not produce a persona — typically because no persona/instruction cognitives exist yet for this user",
      personaMd: null,
      hash: "",
    });
  }

  const persona = memoryEngine.getPersona(effectiveUserId) as {
    personaMd: string;
    cognitiveCountAtGeneration?: number;
    createdTime?: string;
    updatedTime?: string;
  } | null;

  return toolResult({
    userId: effectiveUserId,
    status: "ok",
    personaMd: result.personaMd,
    hash: personaHash(result.personaMd),
    cognitiveCountAtGeneration: persona?.cognitiveCountAtGeneration ?? null,
    createdTime: persona?.createdTime ?? null,
    updatedTime: persona?.updatedTime ?? null,
  });
}
