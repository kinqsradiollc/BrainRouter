import { describe, expect, it } from "vitest";
import { memoryTagsFromSensory, normalizeMemoryTags } from "../memory/capture/memoryTags.js";

describe("deferred memory capture tags", () => {
  it("normalizes identifiers and drops invalid or credential-like values", () => {
    expect(normalizeMemoryTags([
      " Engineering ",
      "engineering",
      "ui:react",
      "not a tag",
      "sk-abcdefghijklmnopqrstuvwxyz",
    ])).toEqual(["engineering", "ui:react"]);
  });

  it("uses the latest sensory context so backlog extraction cannot retain stale workspace tags", () => {
    expect(memoryTagsFromSensory([
      { memoryTags: ["research"] },
      { memoryTags: ["engineering", "ui:react", "engineering"] },
    ])).toEqual(["engineering", "ui:react"]);
  });

  it("bounds recovered tags before they enter cognitive metadata", () => {
    const tags = Array.from({ length: 40 }, (_, index) => `tag-${index}`);
    expect(memoryTagsFromSensory([{ memoryTags: tags }])).toEqual(tags.slice(0, 32));
  });

  it("lets a latest empty context clear older workspace tags", () => {
    expect(memoryTagsFromSensory([
      { memoryTags: ["engineering"] },
      { memoryTags: [] },
    ])).toEqual([]);
  });
});
