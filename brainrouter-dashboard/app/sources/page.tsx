"use client";

// 0.4.3 — Sources view. Surfaces the captured source layer (source_documents +
// source_chunks) that grounds recall provenance: turns / files / tool output
// are chunked, and every distilled memory cites the chunks it came from. Click
// a document to drill into its chunks (the same data `memory_fetch_source_chunk`
// returns to an agent).

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { SourceDocument, SourceChunk } from "@kinqs/brainrouter-types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";

type DocWithCount = SourceDocument & { chunkCount: number };

export default function SourcesPage() {
  const client = useMemo(() => getClient(), []);
  const [docs, setDocs] = useState<DocWithCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<Record<string, SourceChunk[] | "loading">>({});
  // 0.4.3 — transcripts are auto-ingested every turn and dominate this view
  // ("transcript firehose"). Hide them by default so durable sources (files,
  // tool output, tree leaves) are foregrounded; one click reveals them. Old
  // transcripts are pruned via the memory_prune_sources tool.
  const [showTranscripts, setShowTranscripts] = useState(false);

  const transcriptCount = useMemo(
    () => (docs ?? []).filter((d) => d.kind === "transcript").length,
    [docs],
  );
  const visibleDocs = useMemo(
    () => (docs ?? []).filter((d) => showTranscripts || d.kind !== "transcript"),
    [docs, showTranscripts],
  );

  useEffect(() => {
    client
      .getSources({ limit: 100 })
      .then((r) => setDocs(r.documents ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  const toggle = async (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (chunks[id] === undefined) {
      setChunks((c) => ({ ...c, [id]: "loading" }));
      try {
        const r = await client.getSourceChunks(id);
        setChunks((c) => ({ ...c, [id]: r.chunks ?? [] }));
      } catch {
        setChunks((c) => ({ ...c, [id]: [] }));
      }
    }
  };

  return (
    <AuthGuard>
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        <PageHeader
          title="Sources"
          description="Captured source documents chunked for citable, source-grounded recall. Conversation transcripts are auto-captured every turn and hidden by default (toggle below); prune old ones with the memory_prune_sources tool. Click a document to drill into its chunks."
        />

        {error && <p style={{ color: "#fca5a5", fontSize: "13px" }}>Could not load sources: {error}</p>}
        {!docs && !error && <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>Loading sources…</p>}
        {docs && docs.length === 0 && (
          <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>
            No source documents yet. They are captured as the agent works (token-aware capture, 0.4.3).
          </p>
        )}

        {transcriptCount > 0 && (
          <button
            onClick={() => setShowTranscripts((v) => !v)}
            style={{ alignSelf: "flex-start", background: "none", border: "1px solid var(--color-golden-accent)", borderRadius: "6px", color: "var(--color-golden-accent)", cursor: "pointer", fontSize: "12px", letterSpacing: "0.04em", padding: "6px 12px" }}
          >
            {showTranscripts
              ? `Hide ${transcriptCount} conversation transcript${transcriptCount === 1 ? "" : "s"}`
              : `Show ${transcriptCount} hidden conversation transcript${transcriptCount === 1 ? "" : "s"}`}
          </button>
        )}
        {docs && docs.length > 0 && visibleDocs.length === 0 && (
          <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>
            All {transcriptCount} source{transcriptCount === 1 ? "" : "s"} {transcriptCount === 1 ? "is" : "are"} conversation transcript{transcriptCount === 1 ? "" : "s"} (hidden). Use the toggle above to view them, or prune old ones with <code>memory_prune_sources</code>.
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {visibleDocs.map((d) => {
            const open = openId === d.id;
            const loaded = chunks[d.id];
            return (
              <div key={d.id} className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <button
                  onClick={() => toggle(d.id)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, width: "100%" }}
                >
                  <span style={{ color: "var(--color-white-frost)", fontWeight: 500, overflowWrap: "anywhere" }}>
                    <span style={{ color: "var(--color-golden-accent)", fontSize: "11px", letterSpacing: "0.08em", marginRight: "8px" }}>{d.kind.toUpperCase()}</span>
                    {d.title || d.uri || d.id}
                  </span>
                  <span style={{ color: "var(--color-stone-text)", fontSize: "11px", whiteSpace: "nowrap" }}>
                    {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"} · {open ? "▾" : "▸"}
                  </span>
                </button>

                {open && loaded === "loading" && <p style={{ color: "var(--color-stone-text)", fontSize: "12px", margin: 0 }}>Loading chunks…</p>}
                {open && Array.isArray(loaded) && loaded.length === 0 && <p style={{ color: "var(--color-stone-text)", fontSize: "12px", margin: 0 }}>No chunks.</p>}
                {open && Array.isArray(loaded) && loaded.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {loaded.map((c) => (
                      <div key={c.id} style={{ borderLeft: "2px solid var(--color-golden-accent)", paddingLeft: "10px" }}>
                        <div style={{ color: "var(--color-stone-text)", fontSize: "11px", marginBottom: "2px" }}>
                          #{c.ordinal}
                          {c.symbol ? ` · ${c.symbol}` : ""}
                          {c.filePath ? ` · ${c.filePath}` : ""}
                          {c.startLine != null ? ` · L${c.startLine}–${c.endLine}` : ""}
                          {` · ~${c.tokenCount} tok`}
                        </div>
                        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "12px", color: "var(--color-white-frost)", margin: 0, fontFamily: "var(--font-mono, monospace)" }}>
                          {c.content.length > 600 ? `${c.content.slice(0, 600)}…` : c.content}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </motion.div>
    </AuthGuard>
  );
}
