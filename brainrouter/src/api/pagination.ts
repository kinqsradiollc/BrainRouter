import { z } from "zod";

export const PaginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor<T extends Record<string, unknown>>(cursor?: string): T | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Cursor must decode to an object");
    }
    return parsed as T;
  } catch (error) {
    throw new Error("Invalid cursor");
  }
}

export function pageItems<T>(
  items: T[],
  limit: number,
  getCursorPayload: (item: T) => Record<string, unknown>,
): { items: T[]; nextCursor: string | null } {
  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor(getCursorPayload(last)) : null,
  };
}
