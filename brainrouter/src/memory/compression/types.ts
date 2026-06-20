export type ContentKind = "json" | "code" | "log" | "diff" | "text";

export interface CompressResult {
  compressed: string;
  kind: ContentKind;
  strategy: string;
  hash: string | null;
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  savingsPercent: number;
  droppedItems: number;
}
