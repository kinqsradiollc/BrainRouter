"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryListItem, MemoryType } from "@kinqs/brainrouter-types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumModal } from "../../components/PremiumModal";
import { InfiniteScrollSentinel } from "../../components/InfiniteScrollSentinel";
import { MemoryCard } from "../../components/MemoryCard";
import { FilterBar } from "../../components/FilterBar";
import { FilterSelect } from "../../components/FilterSelect";
import { useAuth } from "../../components/AuthProvider";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";

// All cognitive memory types. Mirrors `COGNITIVE_MEMORY_TYPES` in
// @kinqs/brainrouter-types — defined locally (not imported) because that
// module's package transitively pulls `node:crypto`, which the browser
// bundle can't take. Drift is caught at COMPILE time by the exhaustiveness
// guard below: add a MemoryType and this page won't build until it's listed.
const TYPES = [
  "persona", "episodic", "instruction", "skill_context", "tool_preference",
  "codebase_fact", "api_contract", "data_model", "dependency_constraint",
  "environment_constraint", "architecture_decision", "implementation_decision",
  "design_constraint", "security_policy", "performance_baseline", "bug_finding",
  "debug_trace", "fix_summary", "verification_result", "failed_attempt",
  "regression_risk", "task_state", "handover_note", "blocked_reason",
  "review_comment", "release_note", "source_evidence", "artifact_reference",
  "file_history", "command_knowledge", "lesson",
] as const satisfies readonly MemoryType[];

// Compile-time exhaustiveness: if a new MemoryType is added upstream and not
// listed in TYPES, `_MissingType` is a non-`never` union and this errors.
type _MissingType = Exclude<MemoryType, (typeof TYPES)[number]>;
const _typesAreExhaustive: _MissingType extends never ? true : ["missing memory types in TYPES:", _MissingType] = true;
void _typesAreExhaustive;

export default function MemoriesPage() {
  const client = useMemo(() => getClient(), []);
  const { user } = useAuth();
  const { activeOrg, activeOrgId } = useActiveOrg();
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
  // ADR-017 D4 — Personal | Team scope. Team shows the org's shared pool
  // (visibility='org'); `myShared` marks the rows the caller owns (can unshare).
  const [scope, setScope] = useState<"personal" | "team">("personal");
  const [myShared, setMyShared] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (mode: "replace" | "append" = "replace") => {
    if (mode === "append" && (!nextCursor || scope === "team")) return;
    mode === "append" ? setIsLoadingMore(true) : setIsLoading(true);
    setError("");
    try {
      if (scope === "team" && activeOrgId) {
        const res = await client.getOrgSharedMemories(activeOrgId, 200);
        const mine = new Set<string>();
        const items = res.shared.map((m) => {
          if (m.userId === user?.userId) mine.add(m.recordId);
          return { recordId: m.recordId, content: m.content, type: m.type as MemoryType, priority: m.priority, sceneName: "", skillTag: m.skillTag, createdTime: m.createdTime, citationCount: 0, neverCitedCount: 0, archived: false } as MemoryListItem;
        });
        setMyShared(mine);
        setMemories(items);
        setNextCursor(null);
        setHasMore(false);
        setSelected(new Set());
      } else {
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
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memories");
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [client, debouncedQuery, nextCursor, statusFilter, typeFilter, scope, activeOrgId, user?.userId]);

  useEffect(() => {
    void load("replace");
  }, [debouncedQuery, typeFilter, statusFilter, scope]);

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

  const canShareToTeam = Boolean(activeOrg && !activeOrg.isPersonal && activeOrg.plan !== "single");

  async function shareToTeam(id: string) {
    if (!activeOrgId) return;
    try { await client.shareMemory(id, activeOrgId); await load("replace"); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to share memory"); }
  }
  async function makePrivate(id: string) {
    if (!activeOrgId) return;
    try { await client.unshareMemory(id, activeOrgId); await load("replace"); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to make memory private"); }
  }

  return (
    <AuthGuard>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <PageHeader title="Saved knowledge" description="Find and manage the decisions, preferences, facts, and lessons BrainRouter remembers across sessions.">
          <input
            className="pill-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memories"
            style={{ width: "320px" }}
          />
        </PageHeader>

        <FilterBar>
          <FilterBar.Row align="between">
            <FilterBar.Row>
              {canShareToTeam && (
                <>
                  <PremiumButton size="small" variant={scope === "personal" ? "primary" : "ghost"} onClick={() => setScope("personal")}>Personal</PremiumButton>
                  <PremiumButton size="small" variant={scope === "team" ? "primary" : "ghost"} onClick={() => setScope("team")}>{activeOrg?.name ?? "Team"}</PremiumButton>
                </>
              )}
              <FilterSelect
                ariaLabel="Filter by memory type"
                value={typeFilter}
                onChange={setTypeFilter}
                allLabel="All types"
                options={TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))}
              />
            </FilterBar.Row>
            <FilterBar.Row>
              <PremiumButton size="small" variant={statusFilter === "active" ? "primary" : "ghost"} onClick={() => setStatusFilter("active")}>Active</PremiumButton>
              <PremiumButton size="small" variant={statusFilter === "archived" ? "primary" : "ghost"} onClick={() => setStatusFilter("archived")}>Archived</PremiumButton>
            </FilterBar.Row>
          </FilterBar.Row>
          {user?.isAdmin && selected.size > 0 && (
            <FilterBar.Row align="end">
              <span style={{ color: "var(--color-stone-text)", fontSize: "12px", marginRight: "8px" }}>{selected.size} selected</span>
              <PremiumButton variant="ghost" onClick={bulkArchive}>Archive selected</PremiumButton>
              <PremiumButton variant="danger" onClick={bulkDelete}>Delete selected</PremiumButton>
            </FilterBar.Row>
          )}
        </FilterBar>

        {error && <div style={{ color: "#E5675F", fontSize: "13px" }}>{error}</div>}

        <div style={{ display: "grid", gap: "14px" }}>
          {memories.map((memory) => (
            <MemoryCard
              key={memory.recordId}
              memory={memory}
              selected={selected.has(memory.recordId)}
              onSelect={scope === "personal" && user?.isAdmin ? (id, checked) => {
                setSelected((current) => {
                  const next = new Set(current);
                  checked ? next.add(id) : next.delete(id);
                  return next;
                });
              } : undefined}
              onEdit={scope === "personal" ? (target) => {
                setEditTarget(target);
                setEditContent(target.content);
              } : undefined}
              onDelete={scope === "personal" ? setDeleteTargetId : undefined}
              onShare={scope === "personal" && canShareToTeam ? shareToTeam : undefined}
              onUnshare={scope === "team" && myShared.has(memory.recordId) ? makePrivate : undefined}
            />
          ))}
        </div>

        {!isLoading && memories.length === 0 && (
          <EmptyState
            title={debouncedQuery ? "No memories match your search" : "Nothing saved here yet"}
            description={debouncedQuery ? "Try a different query or filter combination." : "Decisions, preferences, and lessons from meetings, notes, and work in progress are saved here as you go — each one keeping the source it came from."}
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
