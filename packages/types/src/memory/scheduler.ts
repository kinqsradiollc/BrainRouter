/**
 * BrainRouter Memory Types — L2/L3 focus, identity, contradictions, scheduler.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

// ============================
// L2 / L3 / Scheduler Types
// ============================

export interface ContextualFocusRecord {
  id: string;
  userId: string;
  sceneName: string;
  summaryMd: string;
  heatScore: number;
  lastActiveTime: string;
  createdTime: string;
  updatedTime: string;
}

export interface CoreIdentityRecord {
  userId: string;
  personaMd: string;
  cognitiveCountAtGeneration: number;
  createdTime: string;
  updatedTime: string;
}

export interface ContradictionRecord {
  id: string;
  user_id?: string;
  userId?: string;
  record_id_a?: string;
  recordIdA?: string;
  record_id_b?: string;
  recordIdB?: string;
  reason: string;
  confidence: number;
  status?: "pending" | "resolved" | "dismissed";
  created_time?: string;
  createdTime?: string;
  content_a?: string;
  contentA?: string;
  content_b?: string;
  contentB?: string;
}

export interface SchedulerState {
  cognitiveCountSinceLastFocus: number;
  cognitiveCountSinceLastIdentity: number;
  totalCognitiveCount: number;
  extractionErrors: number;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
}

export interface StalledExtractionBacklog {
  userId: string;
  sessionKey: string;
  sessionId: string;
  unextractedCount: number;
  latestRecordedAt: string;
  extractionErrors: number;
  lastErrorMessage: string | null;
}

export interface ExtractionStatus {
  extractionErrors: number;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  syncPaused: boolean;
}
