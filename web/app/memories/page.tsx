"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryListItem } from "@brainrouter/types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumModal } from "../../components/PremiumModal";
import { InfiniteScrollSentinel } from "../../components/InfiniteScrollSentinel";
import { MemoryCard } from "../../components/MemoryCard";
import { useAuth } from "../../components/AuthProvider";

const TYPES = ["instruction", "codebase_fact", "architecture_decision", "tool_preference", "task_state", "security_policy"];

export default function MemoriesPage() {
  const client = useMemo(() => getClient(), []);
  const { user } = useAuth();
  const [memories, setMemories] = useState<MemoryListItem[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived">("active");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [editTarget, setEditTarget] = useState<MemoryListItem | null>(null);
  const [editContent, setEditContent] = useState("");
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (mode: "replace" | "append" = "replace") => {
    if (mode === "append" && !nextCursor) return;
    mode === "append" ? setIsLoadingMore(true) : setIsLoading(true);
    setError("");
    try {
      const page = await client.getMemories({
        limit: 20,
        cursor: mode === "append" ? nextCursor ?? undefined : undefined,
        query: debouncedQuery || undefined,
        type: typeFilter || undefined,
        archived: statusFilter === "archived",
      });
      setMemories((current) => mode === "append" ? [...current, ...page.memories] : page.memories);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      if (mode === "replace") setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memories");
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [client, debouncedQuery, nextCursor, statusFilter, typeFilter]);

  useEffect(() => {
    void load("replace");
  }, [debouncedQuery, typeFilter, statusFilter]);

  async function saveEdit() {
    if (!editTarget) return;
    await client.updateMemory(editTarget.recordId, { content: editContent });
    setEditTarget(null);
    setEditContent("");
    await load("replace");
  }

  async function deleteMemory(id: string, hardDelete = false) {
    if (hardDelete && user?.isAdmin) {
      await client.governanceDeleteMemory(id, "Deleted from dashboard");
    } else {
      await client.archiveMemory(id);
    }
    setDeleteTargetId(null);
    await load("replace");
  }

  async function bulkArchive() {
    for (const id of selected) {
      await client.archiveMemory(id);
    }
    await load("replace");
  }

  async function bulkDelete() {
    if (!user?.isAdmin) return;
    for (const id of selected) {
      await client.governanceDeleteMemory(id, "Bulk deleted from dashboard");
    }
    await load("replace");
  }

  return (
    <AuthGuard>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <PageHeader title="Memories" description="Search, filter, edit, and archive semantic memories extracted from agent sessions." />

        <div className="table-container" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <input
            className="pill-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memories"
          />
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <PremiumButton size="small" variant={!typeFilter ? "primary" : "ghost"} onClick={() => setTypeFilter("")}>All</PremiumButton>
            {TYPES.map((type) => (
              <PremiumButton key={type} size="small" variant={typeFilter === type ? "primary" : "ghost"} onClick={() => setTypeFilter(type)}>
                {type}
              </PremiumButton>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <PremiumButton size="small" variant={statusFilter === "active" ? "primary" : "ghost"} onClick={() => setStatusFilter("active")}>Active</PremiumButton>
              <PremiumButton size="small" variant={statusFilter === "archived" ? "primary" : "ghost"} onClick={() => setStatusFilter("archived")}>Archived</PremiumButton>
            </div>
            {user?.isAdmin && selected.size > 0 && (
              <div style={{ display: "flex", gap: "8px" }}>
                <PremiumButton variant="ghost" onClick={bulkArchive}>Archive selected</PremiumButton>
                <PremiumButton variant="danger" onClick={bulkDelete}>Delete selected</PremiumButton>
              </div>
            )}
          </div>
        </div>

        {error && <div style={{ color: "#f87171", fontSize: "13px" }}>{error}</div>}

        <div style={{ display: "grid", gap: "14px" }}>
          {memories.map((memory) => (
            <MemoryCard
              key={memory.recordId}
              memory={memory}
              selected={selected.has(memory.recordId)}
              onSelect={user?.isAdmin ? (id, checked) => {
                setSelected((current) => {
                  const next = new Set(current);
                  checked ? next.add(id) : next.delete(id);
                  return next;
                });
              } : undefined}
              onEdit={(target) => {
                setEditTarget(target);
                setEditContent(target.content);
              }}
              onDelete={setDeleteTargetId}
            />
          ))}
        </div>

        {!isLoading && memories.length === 0 && (
          <EmptyState
            title={debouncedQuery ? "No memories match your search" : "No Semantic Memories"}
            description={debouncedQuery ? "Try a different query or filter combination." : "Active agent sessions will populate this index once memory capture runs."}
          />
        )}
        <InfiniteScrollSentinel hasMore={hasMore} isFetchingMore={isLoadingMore} onLoadMore={() => void load("append")} />

        <PremiumModal isOpen={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Memory">
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <textarea
              className="pill-input"
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              rows={6}
              style={{ borderRadius: "10px", resize: "vertical" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <PremiumButton variant="ghost" onClick={() => setEditTarget(null)}>Cancel</PremiumButton>
              <PremiumButton variant="primary" onClick={saveEdit}>Save</PremiumButton>
            </div>
          </div>
        </PremiumModal>

        <PremiumModal isOpen={!!deleteTargetId} onClose={() => setDeleteTargetId(null)} title="Delete Memory">
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <p style={{ margin: 0, color: "var(--color-stone-text)", fontSize: "14px" }}>
              {user?.isAdmin ? "Archive this memory, or permanently delete it from governance storage." : "Archive this memory?"}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <PremiumButton variant="ghost" onClick={() => setDeleteTargetId(null)}>Cancel</PremiumButton>
              {deleteTargetId && user?.isAdmin && <PremiumButton variant="danger" onClick={() => deleteMemory(deleteTargetId, true)}>Delete</PremiumButton>}
              {deleteTargetId && <PremiumButton variant="primary" onClick={() => deleteMemory(deleteTargetId)}>Archive</PremiumButton>}
            </div>
          </div>
        </PremiumModal>
      </div>
    </AuthGuard>
  );
}
