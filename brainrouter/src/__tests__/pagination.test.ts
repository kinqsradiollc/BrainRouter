import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, pageItems, PaginationQuerySchema } from "../api/pagination.js";

describe("cursor pagination", () => {
  it("encodes and decodes opaque cursor payloads", () => {
    const cursor = encodeCursor({ createdTime: "2026-05-19T00:00:00.000Z", recordId: "l1-1" });
    expect(decodeCursor(cursor)).toEqual({ createdTime: "2026-05-19T00:00:00.000Z", recordId: "l1-1" });
    expect(() => decodeCursor("not-a-cursor")).toThrow("Invalid cursor");
  });

  it("validates cursor query params and caps page size", () => {
    expect(PaginationQuerySchema.parse({ limit: "2" })).toEqual({ limit: 2 });
    expect(() => PaginationQuerySchema.parse({ limit: "101" })).toThrow();
  });

  it("returns a next cursor only when more items exist", () => {
    const page = pageItems([{ id: "a" }, { id: "b" }, { id: "c" }], 2, (item) => ({ id: item.id }));
    expect(page.items).toEqual([{ id: "a" }, { id: "b" }]);
    expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ id: "b" });
  });

  it("omits next cursor when the result set fits in one page", () => {
    const page = pageItems([{ id: "a" }], 2, (item) => ({ id: item.id }));
    expect(page.items).toEqual([{ id: "a" }]);
    expect(page.nextCursor).toBeNull();
  });
});
