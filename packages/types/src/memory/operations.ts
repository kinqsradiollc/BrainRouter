/**
 * BrainRouter Memory Types — evidence, operations, import/export, diagnostics.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

import type { CognitiveRecord, EvidenceKind } from "./records.js";
import type { ExtractionStatus } from "./scheduler.js";

export interface MemoryEvidence {
  id: string;
  userId: string;
  recordId: string;
  kind: EvidenceKind;
  ref: string;
  excerpt: string;
  observedAt: string;
  metadata: Record<string, unknown>;
}

export interface MemoryOperation {
  id: string;
  userId: string;
  recordId: string | null;
  operation: string;
  actor: string;
  sessionKey: string;
  reason: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface MemoryExport {
  version: 1;
  exportedAt: string;
  userId: string;
  memories: CognitiveRecord[];
  evidence: MemoryEvidence[];
  operations: MemoryOperation[];
}

export interface MemoryImport {
  version: 1;
  memories: CognitiveRecord[];
  evidence?: MemoryEvidence[];
  operations?: MemoryOperation[];
}

export interface ImportResult {
  importedMemories: number;
  importedEvidence: number;
  importedOperations: number;
}

export interface DiagnosticsBundle {
  timestamp: string;
  sqliteVersion: string;
  nodeVersion: string;
  databaseStats: {
    userStats: {
      total: number;
      archived: number;
      byType: Record<string, number>;
      citationRate: number;
      lastRecallAt: string | null;
      /** Rows in sensory_stream — always written on capture; useful when
       *  `total` is 0 but capture is firing (cognitive extraction hasn't run yet). */
      sensoryTotal: number;
      /** Sensory rows the cognitive extractor hasn't consumed yet. */
      sensoryUnextracted: number;
      /** Rows in contextual_focus for this user. */
      focusSceneTotal: number;
      extraction: ExtractionStatus;
    };
  };
  envKeys: string[];
  recentErrors: MemoryOperation[];
}
