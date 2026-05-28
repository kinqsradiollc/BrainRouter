import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getPersona: vi.fn(),
    distillPersona: vi.fn(),
  },
}));

import { memoryEngine } from "../memory/engine.js";
import {
  handleMemoryPersona,
  handleMemoryPersonaRefresh,
} from "../tools/memory_persona.js";

function parseToolText<T>(result: any): T {
  return JSON.parse(result.content[0].text);
}

describe("memory_persona tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.getPersona).mockReset();
    vi.mocked(memoryEngine.distillPersona).mockReset();
  });

  it("returns persona body, stable 16-char hash, and metadata when one exists", async () => {
    vi.mocked(memoryEngine.getPersona).mockReturnValue({
      userId: "u1",
      personaMd: "# Anh\nSenior engineer focused on memory pipelines.",
      cognitiveCountAtGeneration: 7,
      createdTime: "2026-05-20T00:00:00Z",
      updatedTime: "2026-05-28T00:00:00Z",
    } as any);

    const res = parseToolText<any>(
      await handleMemoryPersona({ userId: "u1" }),
    );
    expect(res.personaMd).toContain("Senior engineer");
    expect(res.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(res.cognitiveCountAtGeneration).toBe(7);
    expect(res.updatedTime).toBe("2026-05-28T00:00:00Z");
  });

  it("returns null persona with a reason when no Core Identity exists", async () => {
    vi.mocked(memoryEngine.getPersona).mockReturnValue(null);
    const res = parseToolText<any>(await handleMemoryPersona({}));
    expect(res.personaMd).toBeNull();
    expect(res.hash).toBe("");
    expect(res.reason).toMatch(/no Core Identity/i);
  });

  it("falls back to defaultUserId when userId is omitted", async () => {
    vi.mocked(memoryEngine.getPersona).mockReturnValue(null);
    await handleMemoryPersona({}, { defaultUserId: "fallback-user" });
    expect(memoryEngine.getPersona).toHaveBeenCalledWith("fallback-user");
  });

  it("produces a different hash when persona content changes", async () => {
    vi.mocked(memoryEngine.getPersona).mockReturnValueOnce({
      personaMd: "v1",
    } as any);
    const a = parseToolText<any>(await handleMemoryPersona({}));

    vi.mocked(memoryEngine.getPersona).mockReturnValueOnce({
      personaMd: "v2",
    } as any);
    const b = parseToolText<any>(await handleMemoryPersona({}));

    expect(a.hash).not.toBe(b.hash);
  });
});

describe("memory_persona_refresh tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.getPersona).mockReset();
    vi.mocked(memoryEngine.distillPersona).mockReset();
  });

  it("returns the freshly distilled persona on success", async () => {
    vi.mocked(memoryEngine.distillPersona).mockResolvedValue({
      success: true,
      personaMd: "# Refreshed\nBody.",
    });
    vi.mocked(memoryEngine.getPersona).mockReturnValue({
      userId: "u1",
      personaMd: "# Refreshed\nBody.",
      cognitiveCountAtGeneration: 12,
      createdTime: "2026-05-20T00:00:00Z",
      updatedTime: "2026-05-28T00:00:00Z",
    } as any);

    const res = parseToolText<any>(
      await handleMemoryPersonaRefresh({ userId: "u1" }),
    );
    expect(res.status).toBe("ok");
    expect(res.personaMd).toContain("Refreshed");
    expect(res.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(res.cognitiveCountAtGeneration).toBe(12);
  });

  it("returns status=skipped with a reason when distillation produces nothing", async () => {
    vi.mocked(memoryEngine.distillPersona).mockResolvedValue({
      success: false,
    });
    const res = parseToolText<any>(
      await handleMemoryPersonaRefresh({ userId: "u1" }),
    );
    expect(res.status).toBe("skipped");
    expect(res.reason).toMatch(/distillation/i);
    expect(res.personaMd).toBeNull();
  });

  it("falls back to defaultUserId when userId is omitted", async () => {
    vi.mocked(memoryEngine.distillPersona).mockResolvedValue({
      success: false,
    });
    await handleMemoryPersonaRefresh({}, { defaultUserId: "fallback-user" });
    expect(memoryEngine.distillPersona).toHaveBeenCalledWith("fallback-user");
  });
});
