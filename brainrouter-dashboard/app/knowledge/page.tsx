"use client";

import Link from "next/link";
import { type KeyboardEvent, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DataTable, StatusBadge } from "../../components/Analytics";
import { EmptyState } from "../../components/EmptyState";
import { KnowledgeScopePicker, useKnowledgeScope } from "../../components/KnowledgeScopePicker";
import { PageHeader } from "../../components/PageHeader";
import { PremiumButton } from "../../components/PremiumButton";
import { ProjectKnowledgeLibrary } from "../../components/ProjectKnowledgeLibrary";
type KnowledgeSection = "overview" | "library" | "quality" | "connections" | "profile";

const SECTIONS: Array<{ id: KnowledgeSection; label: string; description: string }> = [
  { id: "overview", label: "Overview", description: "How knowledge helps" },
  { id: "library", label: "Library", description: "Saved and connected" },
  { id: "quality", label: "Quality", description: "Sources and conflicts" },
  { id: "connections", label: "Connections", description: "History and relationships" },
  { id: "profile", label: "Profile", description: "Identity and review" },
];

const KNOWLEDGE_AREAS: Record<Exclude<KnowledgeSection, "overview">, Array<{ href: string; title: string; copy: string; action: string }>> = {
  library: [
    { href: "/memories", title: "Saved knowledge", copy: "Decisions, preferences, facts, and lessons BrainRouter can bring into future work.", action: "Browse saved knowledge" },
    { href: "/sources", title: "Connected sources", copy: "Documents and conversations that give answers a clear place of origin.", action: "Manage sources" },
    { href: "/working-memory", title: "Current task context", copy: "The short list of steps and references BrainRouter is using right now.", action: "View current context" },
    { href: "/scenes", title: "Topic summaries", copy: "Recurring themes condensed into readable summaries instead of scattered notes.", action: "Explore summaries" },
  ],
  quality: [
    { href: "/evidence", title: "Supporting evidence", copy: "Files, commands, tests, links, and other references behind saved knowledge.", action: "Review evidence" },
    { href: "/contradictions", title: "Conflicts to review", copy: "Places where newer information disagrees with something BrainRouter already knows.", action: "Resolve conflicts" },
    { href: "/recall-inspector", title: "Why this was recalled", copy: "See why a piece of knowledge was considered useful for a question.", action: "Explain a recall" },
  ],
  connections: [
    { href: "/timeline", title: "Activity history", copy: "A chronological view of when knowledge was saved, used, updated, or moved.", action: "Open history" },
    { href: "/tree", title: "Knowledge map", copy: "A browsable hierarchy that rolls detailed notes into larger topics and summaries.", action: "Browse the map" },
    { href: "/intelligence", title: "Related ideas", copy: "See which people, projects, and concepts connect across your workspace.", action: "Explore connections" },
  ],
  profile: [
    { href: "/persona", title: "Agent profile", copy: "Stable working preferences and patterns that shape how BrainRouter responds.", action: "View the profile" },
    { href: "/learned-behaviors", title: "Learned behavior", copy: "Inspect tenant-scoped behavior changes, their provenance, measured outcomes, and reversible lifecycle.", action: "Review learned behavior" },
    { href: "/blackboard", title: "Review queue", copy: "New knowledge waiting to be checked before it becomes part of the durable record.", action: "Review candidates" },
    { href: "/vault", title: "Export archive", copy: "A readable, version-friendly copy of durable knowledge for backup and review.", action: "Open the archive" },
  ],
};

const KNOWLEDGE_FLOW = [
  ["Notice", "Important decisions, preferences, outcomes, and sources are captured while work happens."],
  ["Organize", "Current-task context stays separate from durable knowledge, so the prompt remains focused."],
  ["Recall", "BrainRouter finds the small set of context that can genuinely help with the next question."],
  ["Check", "Evidence stays attached, conflicts are surfaced, and you can inspect why context appeared."],
] as const;

function formatKind(kind: string) {
  return kind.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function KnowledgeLinks({ section }: { section: Exclude<KnowledgeSection, "overview"> }) {
  return (
    <div className="knowledge-link-grid">
      {KNOWLEDGE_AREAS[section].map((area, index) => (
        <Link href={area.href} className="knowledge-link-card" key={area.href}>
          <span className="knowledge-link-index">0{index + 1}</span>
          <div><h2>{area.title}</h2><p>{area.copy}</p></div>
          <strong>{area.action} <span aria-hidden>→</span></strong>
        </Link>
      ))}
    </div>
  );
}

function KnowledgePageContent() {
  const scopeState = useKnowledgeScope();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("internal");
  const [section, setSection] = useState<KnowledgeSection>("overview");
  const sources = scopeState.sources;
  const loading = scopeState.loading;

  const scopedSources = useMemo(() => sources
    .filter((source) => !scopeState.scope.workspaceTag || source.workspaceTag === scopeState.scope.workspaceTag), [sources, scopeState.scope.workspaceTag]);
  const kinds = useMemo(() => [...new Set(scopedSources.map((source) => source.kind))].sort(), [scopedSources]);
  const rows = useMemo(() => scopedSources
    .filter((source) => kind === "all" || (kind === "internal" && source.kind !== "transcript") || source.kind === kind)
    .filter((source) => `${source.title ?? ""} ${source.uri ?? ""} ${source.kind}`.toLowerCase().includes(search.toLowerCase())), [scopedSources, search, kind]);
  const searchableSections = useMemo(() => scopedSources.reduce((total, source) => total + (source.chunkCount ?? 0), 0), [scopedSources]);
  const addSourceHref = useMemo(() => {
    const query = new URLSearchParams({ panel: "connections" });
    if (scopeState.scope.orgId) query.set("orgId", scopeState.scope.orgId);
    if (scopeState.scope.projectId) query.set("projectId", scopeState.scope.projectId);
    return `/integrations?${query.toString()}`;
  }, [scopeState.scope.orgId, scopeState.scope.projectId]);
  const sourceHref = (sourceId: string) => {
    const query = new URLSearchParams({ source: sourceId });
    if (scopeState.scope.orgId) query.set("orgId", scopeState.scope.orgId);
    if (scopeState.scope.projectId) query.set("projectId", scopeState.scope.projectId);
    if (scopeState.scope.workspaceTag) query.set("workspaceTag", scopeState.scope.workspaceTag);
    return `/sources?${query.toString()}`;
  };
  const moveSection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % SECTIONS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = SECTIONS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = SECTIONS[nextIndex];
    setSection(next.id);
    requestAnimationFrame(() => document.getElementById(`knowledge-tab-${next.id}`)?.focus());
  };

  return (
    <div className="settings-page knowledge-hub">
      <PageHeader title="Knowledge" description="See what BrainRouter remembers, where it came from, and how it can help your work.">
        <Link href={addSourceHref}><PremiumButton variant="primary">Add a source</PremiumButton></Link>
      </PageHeader>

      <div className="knowledge-tabs" role="tablist" aria-label="Knowledge sections">
        {SECTIONS.map((item, index) => (
          <button type="button" role="tab" id={`knowledge-tab-${item.id}`} aria-controls={`knowledge-panel-${item.id}`} aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} className={section === item.id ? "active" : ""} onKeyDown={(event) => moveSection(event, index)} onClick={() => setSection(item.id)} key={item.id}>
            <strong>{item.label}</strong><span>{item.description}</span>
          </button>
        ))}
      </div>
      <KnowledgeScopePicker state={scopeState} compact />

      {section === "overview" && (
        <div id="knowledge-panel-overview" className="knowledge-overview-panel" role="tabpanel" aria-labelledby="knowledge-tab-overview">
          <section className="knowledge-intro">
            <div>
              <span className="knowledge-eyebrow">Useful context, kept understandable</span>
              <h2>BrainRouter remembers the parts of work you should not have to repeat.</h2>
              <p>It keeps project decisions, preferences, source material, and lessons available across sessions—while letting you see and correct what it knows.</p>
            </div>
            <dl className="knowledge-summary" aria-label="Knowledge summary">
              <div><dt>Sources</dt><dd>{loading ? "—" : scopedSources.length}</dd></div>
              <div><dt>Searchable sections</dt><dd>{loading ? "—" : searchableSections}</dd></div>
              <div><dt>Source types</dt><dd>{loading ? "—" : kinds.length}</dd></div>
            </dl>
          </section>

          <section className="knowledge-flow" aria-labelledby="knowledge-flow-title">
            <div className="knowledge-section-heading"><span>How it works</span><h2 id="knowledge-flow-title">From work to useful context</h2></div>
            <div className="knowledge-flow-grid">
              {KNOWLEDGE_FLOW.map(([title, copy], index) => <article key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{copy}</p></article>)}
            </div>
          </section>

          <section className="knowledge-start">
            <div><span>Explore the full system</span><h2>Every earlier knowledge view is still here.</h2><p>Use the categories above to browse the library, check quality, follow connections, or manage the agent profile.</p></div>
            <button type="button" onClick={() => setSection("library")}>Open the library <span aria-hidden>→</span></button>
          </section>
        </div>
      )}

      {section === "library" && (
        <div id="knowledge-panel-library" className="knowledge-category-panel" role="tabpanel" aria-labelledby="knowledge-tab-library">
          <KnowledgeLinks section="library" />
          <ProjectKnowledgeLibrary
            orgId={scopeState.scope.orgId}
            projectId={scopeState.scope.projectId}
          />
          <section className="knowledge-source-panel">
            <div className="knowledge-section-heading"><span>Connected material</span><h2>Sources ready to use</h2><p>Search by name or narrow the list by source type.</p></div>
            <div className="knowledge-source-filters">
              <input className="settings-input" aria-label="Search knowledge" placeholder="Search by name" value={search} onChange={(event) => setSearch(event.target.value)} />
              <select className="settings-select" aria-label="Knowledge type" value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="internal">Workspace sources</option><option value="all">All sources</option>
                {kinds.map((value) => <option value={value} key={value}>{formatKind(value)}</option>)}
              </select>
            </div>
            {scopeState.error && <div className="settings-note settings-note--error">We could not load your sources. {scopeState.error}</div>}
            {rows.length ? (
              <DataTable headers={["Name", "Type", "Searchable sections", "Added"]}>
                {rows.map((source) => <tr key={source.id}><td><Link href={sourceHref(source.id)}>{source.title || source.uri || source.id}</Link></td><td><StatusBadge tone={source.kind === "transcript" ? "neutral" : "info"}>{formatKind(source.kind)}</StatusBadge></td><td>{source.chunkCount}</td><td>{source.createdAt ? new Date(source.createdAt).toLocaleDateString() : "—"}</td></tr>)}
              </DataTable>
            ) : <EmptyState title={loading ? "Loading your knowledge…" : "No sources match this view"} description={loading ? "BrainRouter is gathering your connected material." : "Try a different search or connect a new source."} />}
          </section>
        </div>
      )}

      {section === "quality" && <div id="knowledge-panel-quality" className="knowledge-category-panel" role="tabpanel" aria-labelledby="knowledge-tab-quality"><KnowledgeLinks section="quality" /></div>}
      {section === "connections" && <div id="knowledge-panel-connections" className="knowledge-category-panel" role="tabpanel" aria-labelledby="knowledge-tab-connections"><KnowledgeLinks section="connections" /></div>}
      {section === "profile" && <div id="knowledge-panel-profile" className="knowledge-category-panel" role="tabpanel" aria-labelledby="knowledge-tab-profile"><KnowledgeLinks section="profile" /></div>}
    </div>
  );
}

export default function KnowledgePage() {
  return <AuthGuard><KnowledgePageContent /></AuthGuard>;
}
