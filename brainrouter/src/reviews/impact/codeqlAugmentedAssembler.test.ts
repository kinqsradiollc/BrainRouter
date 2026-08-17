import { describe, it, expect, vi } from "vitest";
import {
  CodeqlAugmentedImpactAssembler,
  type CodeqlPathProvider,
} from "./codeqlAugmentedAssembler.js";
import type {
  AssembleAssuranceImpactPacketsInput,
  AssuranceImpactPacket,
  AssuranceImpactPacketAssembly,
  AssuranceSourceToSinkPath,
} from "@kinqs/brainrouter-types/review";
import type { RepositoryAssuranceImpactPort } from "@kinqs/brainrouter-core/review";

const input = {
  program: "security",
  revision: { headSha: "abc" },
} as unknown as AssembleAssuranceImpactPacketsInput;

const packet = (id: string): AssuranceImpactPacket =>
  ({
    id,
    revisionSha: "abc",
    program: "security",
    changed: [],
    context: [],
    sourceToSinkPaths: [],
    artifactRefs: [],
    byteCount: 0,
    truncated: false,
    limitationIds: [],
  }) as unknown as AssuranceImpactPacket;

const baseAssembly = (packets: AssuranceImpactPacket[]): AssuranceImpactPacketAssembly =>
  ({
    revisionSha: "abc",
    indexRef: "idx",
    packets,
    limitations: [],
    assembledAt: "t",
  }) as unknown as AssuranceImpactPacketAssembly;

const path = (id: string): AssuranceSourceToSinkPath => ({
  id,
  mechanism: "data_flow",
  source: { path: "a.ts", line: 1 },
  sink: { path: "b.ts", line: 2 },
  evidenceRefs: [],
});

const makeBase = (assembly: AssuranceImpactPacketAssembly): RepositoryAssuranceImpactPort => ({
  assemble: vi.fn(async () => assembly),
});

describe("CodeqlAugmentedImpactAssembler", () => {
  it("appends one CodeQL packet carrying the provider's paths", async () => {
    const base = makeBase(baseAssembly([packet("ts")]));
    const provider: CodeqlPathProvider = async () => [path("codeql:1"), path("codeql:2")];
    const out = await new CodeqlAugmentedImpactAssembler(base, provider).assemble(input);
    expect(out.packets).toHaveLength(2);
    const cq = out.packets.find((p) => p.id.startsWith("codeql:"));
    expect(cq?.sourceToSinkPaths).toHaveLength(2);
    expect(cq?.revisionSha).toBe("abc");
    expect(cq?.program).toBe("security");
  });

  it("passes the base assembly through unchanged when the provider returns no paths", async () => {
    const base = makeBase(baseAssembly([]));
    const out = await new CodeqlAugmentedImpactAssembler(base, async () => []).assemble(input);
    expect(out.packets).toHaveLength(0);
  });

  it("is failure-tolerant: a throwing provider yields the base assembly", async () => {
    const base = makeBase(baseAssembly([packet("ts")]));
    const out = await new CodeqlAugmentedImpactAssembler(base, async () => {
      throw new Error("code scanning unavailable");
    }).assemble(input);
    expect(out.packets).toHaveLength(1);
    expect(out.packets[0].id).toBe("ts");
  });
});
