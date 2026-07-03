export interface OpenTaskCard {
  id: string;
  kind: string;
}

export interface TaskTranscriptResult {
  id?: string;
  kind?: string;
}

export interface OpenWorkflowCard {
  slug: string;
}

export interface WorkflowDetailResult {
  slug?: string;
}

export function shouldApplyTaskTranscript(prev: OpenTaskCard | null, result: TaskTranscriptResult | null | undefined): boolean {
  if (!prev || !result?.id || !result.kind) return false;
  return prev.id === result.id && prev.kind === result.kind;
}

export function shouldApplyWorkflowDetail(prev: OpenWorkflowCard | null, result: WorkflowDetailResult | null | undefined): boolean {
  if (!prev || !result?.slug) return false;
  return prev.slug === result.slug;
}
