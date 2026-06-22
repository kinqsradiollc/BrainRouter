/**
 * Shared review view-types + the gate label map, used by BOTH the Changes
 * panel (gate banner above the commit row) and the Review panel (finding
 * cards + gate). Kept separate so neither panel has to import the other.
 */
export interface ReviewFindingView {
  id?: string; file: string; line?: number; endLine?: number; severity: string; confidence: number;
  summary: string; details?: string; suggestion?: string; codeExcerpt?: string; diffHunk?: string;
  patch?: string; status?: string; canApply?: boolean;
}
export interface ReviewGateView { status: string; blocked: boolean; reason: string }

export const GATE_LABEL: Record<string, string> = { clean: '✓ Review passed', blocked: '⚠ Blocking findings', stale: '↻ Review out of date', 'needs-review': '○ Needs review', running: '… Reviewing' };
