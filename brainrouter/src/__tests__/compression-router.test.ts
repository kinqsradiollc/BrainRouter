import { describe, expect, it } from "vitest";
import { decodeLosslessTable, detectKind } from "../memory/compression/router.js";

describe("compression content routing", () => {
  it("classifies structured JSON, diffs, logs, code, and plain text", () => {
    expect(detectKind('[{"id":1}]')).toBe("json");
    expect(detectKind("diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new")).toBe("diff");
    expect(detectKind("2026-06-20T00:00:00Z INFO boot\n2026-06-20T00:00:01Z WARN slow\n2026-06-20T00:00:02Z ERROR failed\n2026-06-20T00:00:03Z INFO retry")).toBe("log");
    expect(detectKind("import { join } from 'node:path';\nexport function run() {}" )).toBe("code");
    expect(detectKind("A short human-readable paragraph.")).toBe("text");
  });

  it("reconstructs homogeneous rows exactly from the lossless table representation", () => {
    const rows = [
      { id: 1, status: "ok", retried: false, detail: null },
      { id: 2, status: "warning", retried: true, detail: "timeout" },
    ];
    const encoded = '[2]{id:number,status:string,retried:boolean,detail:string|null}\nid,status,retried,detail\n1,ok,false,\n2,warning,true,timeout';

    expect(decodeLosslessTable(encoded)).toEqual(rows);
  });
});
