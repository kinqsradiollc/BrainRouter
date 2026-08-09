import type {
  AssuranceCodeIndexReceipt,
  AssuranceCodeRelationshipEdge,
  AssuranceCodeSymbol,
  AssuranceCoverageLimitation,
  AssuranceSourceLocation,
} from '@kinqs/brainrouter-types/review';

export interface ParserBackedIndexHandle {
  indexRef: string;
  revisionSha: string;
  receipt: AssuranceCodeIndexReceipt;
  symbols: AssuranceCodeSymbol[];
  relationships: AssuranceCodeRelationshipEdge[];
  /** Exact inventory path pairs that do not require a shared parsed symbol. */
  pathRelationships?: Array<[string, string]>;
  limitations: AssuranceCoverageLimitation[];
}

export interface CheckoutIndexHandle {
  checkoutRef: string;
  eligiblePaths: string[];
  revisionSha: string;
}

export interface CheckoutIndexResolver {
  resolve(checkoutRef: string): CheckoutIndexHandle | null;
  readEligibleTextFile(checkoutRef: string, relativePath: string, maxBytes: number): Promise<string>;
}

export interface ParserBackedIndexResolver {
  resolve(indexRef: string): ParserBackedIndexHandle | null;
}

export interface DeepReviewAnchorSelection {
  anchors: AssuranceSourceLocation[];
  indexedFiles: number;
}
