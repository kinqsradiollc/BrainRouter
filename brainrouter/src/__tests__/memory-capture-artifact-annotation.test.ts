import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    upsertEngineeringMemory: vi.fn(),
  },
}));

import { memoryEngine } from "../memory/engine.js";
import { handleMemoryCaptureArtifact, memoryCaptureArtifactToolSchema } from "../tools/capture/memory_capture_artifact.js";
import { handleMemoryCaptureAnnotation, memoryCaptureAnnotationToolSchema } from "../tools/capture/memory_capture_annotation.js";

function parseToolText<T>(result: any): T {
  return JSON.parse(result.content[0].text);
}

describe("memory_capture_artifact tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.upsertEngineeringMemory).mockReset();
    vi.mocked(memoryEngine.upsertEngineeringMemory).mockReturnValue({ id: "cognitive_manual_art1" } as never);
  });

  it("captures an artifact_reference record stamped with the session + kind:'artifact' provenance", async () => {
    const result = await handleMemoryCaptureArtifact(
      {
        title: "OAuth flow diagram",
        summary: "PKCE login sequence",
        artifactKind: "sketch",
        format: "mermaid",
        status: "draft",
        artifactId: "art_9",
        requirementId: "req_1",
        taskId: "task_7",
        sessionKey: "sess:design",
      },
      { defaultUserId: "u1" },
    );
    expect(memoryEngine.upsertEngineeringMemory).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(memoryEngine.upsertEngineeringMemory).mock.calls[0][0];
    expect(arg.userId).toBe("u1");
    expect(arg.type).toBe("artifact_reference");
    expect(arg.sessionKey).toBe("sess:design"); // SESSION-SCOPED
    expect(arg.content).toContain("OAuth flow diagram");
    expect(arg.metadata).toEqual({
      kind: "artifact",
      artifactId: "art_9",
      requirementId: "req_1",
      taskId: "task_7",
      artifactKind: "sketch",
      format: "mermaid",
      status: "draft",
    });
    const out = parseToolText<{ recordId: string; artifactId: string }>(result);
    expect(out.recordId).toBe("cognitive_manual_art1");
    expect(out.artifactId).toBe("art_9");
  });

  it("schema requires title + declares artifact provenance inputs", () => {
    expect(memoryCaptureArtifactToolSchema.name).toBe("memory_capture_artifact");
    expect(memoryCaptureArtifactToolSchema.inputSchema.required).toContain("title");
    for (const k of ["artifactId", "requirementId", "taskId", "sessionKey"]) {
      expect(memoryCaptureArtifactToolSchema.inputSchema.properties).toHaveProperty(k);
    }
  });
});

describe("memory_capture_annotation tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.upsertEngineeringMemory).mockReset();
    vi.mocked(memoryEngine.upsertEngineeringMemory).mockReturnValue({ id: "cognitive_manual_anno1" } as never);
  });

  it("captures a review_comment record stamped with the session + kind:'annotation' anchor provenance", async () => {
    const result = await handleMemoryCaptureAnnotation(
      {
        title: "Off-by-one in the loop bound",
        body: "Should be < length, not <=",
        annotationId: "anno_3",
        targetKind: "file",
        filePath: "src/loop.ts",
        startLine: 42,
        endLine: 42,
        severity: "high",
        status: "open",
        sessionKey: "sess:review",
      },
      { defaultUserId: "u1" },
    );
    const arg = vi.mocked(memoryEngine.upsertEngineeringMemory).mock.calls[0][0];
    expect(arg.type).toBe("review_comment");
    expect(arg.sessionKey).toBe("sess:review"); // SESSION-SCOPED
    expect(arg.filePaths).toEqual(["src/loop.ts"]);
    expect(arg.content).toContain("src/loop.ts:42");
    expect(arg.metadata).toMatchObject({ kind: "annotation", annotationId: "anno_3", targetKind: "file", filePath: "src/loop.ts", startLine: 42, severity: "high" });
    const out = parseToolText<{ recordId: string; annotationId: string }>(result);
    expect(out.recordId).toBe("cognitive_manual_anno1");
    expect(out.annotationId).toBe("anno_3");
  });

  it("schema requires title", () => {
    expect(memoryCaptureAnnotationToolSchema.name).toBe("memory_capture_annotation");
    expect(memoryCaptureAnnotationToolSchema.inputSchema.required).toContain("title");
  });
});
