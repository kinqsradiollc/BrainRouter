'use client';

import type {
  BrainChatCitation,
  BrainChatRequest,
  BrainChatResponse,
  ModelReasoningEffort,
  SourceChunk,
  SourceDocument,
} from '@kinqs/brainrouter-types';
import { authFetch } from './adminApi';

export type BrainChatMessage = BrainChatRequest['messages'][number];
export type { BrainChatCitation, BrainChatResponse };

export interface KnowledgeScope {
  orgId: string;
  projectId: string;
  workspaceTag: string;
}

export type ScopedSourceDocument = SourceDocument & {
  chunkCount: number;
  orgId?: string | null;
  projectId?: string | null;
  workspaceLabel?: string | null;
};

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export const brainApi = {
  chat: (
    messages: BrainChatMessage[],
    sessionKey: string,
    scope: KnowledgeScope,
    selection?: { model?: string; reasoningEffort?: ModelReasoningEffort | '' },
  ) =>
    authFetch<BrainChatResponse>('/api/brain/chat', {
      method: 'POST',
      orgId: scope.orgId || undefined,
      body: {
        messages,
        sessionKey,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.workspaceTag ? { workspaceTag: scope.workspaceTag } : {}),
        ...(selection?.model ? { model: selection.model } : {}),
        ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      },
    }),
  listSources: (scope: KnowledgeScope, limit = 100, signal?: AbortSignal) =>
    authFetch<{ documents: ScopedSourceDocument[] }>(
      `/api/brain/sources${queryString({
        limit,
        projectId: scope.projectId || undefined,
        workspaceTag: scope.workspaceTag || undefined,
      })}`,
      { orgId: scope.orgId || undefined, signal },
    ),
  sourceChunks: (documentId: string, orgId?: string, signal?: AbortSignal) =>
    authFetch<{ chunks: SourceChunk[] }>(`/api/brain/sources/${encodeURIComponent(documentId)}/chunks`, {
      orgId,
      signal,
    }),
};
