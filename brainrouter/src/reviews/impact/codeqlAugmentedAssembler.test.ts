import { describe, it, expect, vi } from "vitest";
import {
  CODEQL_NOT_ANALYZED_LIMITATION_ID,
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
    const provider: CodeqlPathProvider = async () => ({
      status: "analyzed",
      paths: [path("codeql:1"), path("codeql:2")],
    });
    const out = await new CodeqlAugmentedImpactAssembler(base, provider).assemble(input);
    expect(out.packets).toHaveLength(2);
    const cq = out.packets.find((p) => p.id.startsWith("codeql:"));
    expect(cq?.sourceToSinkPaths).toHaveLength(2);
    expect(cq?.revisionSha).toBe("abc");
    expect(cq?.program).toBe("security");
    // Analyzed-with-findings adds no coverage limitation.
    expect(out.limitations).toHaveLength(0);
  });

  it("analyzed-and-empty is a clean result: no packet, no limitation", async () => {
    const base = makeBase(baseAssembly([]));
    const out = await new CodeqlAugmentedImpactAssembler(base, async () => ({
      status: "analyzed",
      paths: [],
    })).assemble(input);
    expect(out.packets).toHaveLength(0);
    expect(out.limitations).toHaveLength(0);
  });

  it("unavailable attaches a CODEQL_NOT_ANALYZED coverage limitation (never reads as clean)", async () => {
    const base = makeBase(baseAssembly([packet("ts")]));
    const out = await new CodeqlAugmentedImpactAssembler(base, async () => ({
      status: "unavailable",
      reasonCode: "NO_MATCHING_ANALYSIS",
    })).assemble(input);
    // The base packets are untouched — augmentation never drops the TS analyzer.
    expect(out.packets).toHaveLength(1);
    expect(out.packets[0].id).toBe("ts");
    const limitation = out.limitations.find((l) => l.id === CODEQL_NOT_ANALYZED_LIMITATION_ID);
    expect(limitation).toMatchObject({
      component: "codeql_taint",
      state: "unavailable",
      reasonCode: "NO_MATCHING_ANALYSIS",
    });
    expect(limitation?.summary).toContain("not evidence of safety");
  });

  it("is failure-tolerant: a throwing provider is treated as unavailable, not clean", async () => {
    const base = makeBase(baseAssembly([packet("ts")]));
    const out = await new CodeqlAugmentedImpactAssembler(base, async () => {
      throw new Error("code scanning unavailable");
    }).assemble(input);
    expect(out.packets).toHaveLength(1);
    expect(out.packets[0].id).toBe("ts");
    const limitation = out.limitations.find((l) => l.id === CODEQL_NOT_ANALYZED_LIMITATION_ID);
    expect(limitation?.reasonCode).toBe("PROVIDER_ERROR");
  });

  it("does not duplicate the limitation id when the base already carries one", async () => {
    const seeded = baseAssembly([]);
    seeded.limitations = [{
      id: CODEQL_NOT_ANALYZED_LIMITATION_ID,
      component: "codeql_taint",
      state: "unavailable",
      reasonCode: "STALE",
      summary: "stale",
    }];
    const out = await new CodeqlAugmentedImpactAssembler(makeBase(seeded), async () => ({
      status: "unavailable",
      reasonCode: "ANALYSES_LIST_HTTP_404",
    })).assemble(input);
    const matches = out.limitations.filter((l) => l.id === CODEQL_NOT_ANALYZED_LIMITATION_ID);
    expect(matches).toHaveLength(1);
    // The fresh reason wins over the seeded one.
    expect(matches[0].reasonCode).toBe("ANALYSES_LIST_HTTP_404");
  });
});
