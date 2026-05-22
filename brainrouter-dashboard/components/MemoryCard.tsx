"use client";

import { motion } from "framer-motion";
import type { MemoryListItem } from "@kinqs/brainrouter-types";
import { MemoryBadge } from "./MemoryBadge";
import { PremiumButton } from "./PremiumButton";

interface MemoryCardProps {
  memory: MemoryListItem;
  selected?: boolean;
  onSelect?: (id: string, selected: boolean) => void;
  onEdit: (memory: MemoryListItem) => void;
  onDelete: (id: string) => void;
}

export function MemoryCard({ memory, selected = false, onSelect, onEdit, onDelete }: MemoryCardProps) {
  const priority = Math.max(0, Math.min(100, Math.round((memory.priority ?? 0) * 100)));
  return (
    <motion.article
      whileHover={{ scale: 1.01 }}
      className="card-premium"
      style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "18px" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          {onSelect && (
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => onSelect(memory.recordId, event.target.checked)}
              style={{ accentColor: "#cc9166" }}
              aria-label={`Select memory ${memory.recordId}`}
            />
          )}
          <span style={{ border: "1px solid var(--border-med)", borderRadius: "4px", padding: "2px 6px", background: "var(--color-pewter-accent)", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {memory.type}
          </span>
          {memory.archived && <span className="badge">Archived</span>}
        </div>
        <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
          <PremiumButton variant="ghost" style={{ padding: "6px 12px", fontSize: "12px" }} onClick={() => onEdit(memory)}>
            Edit
          </PremiumButton>
          <PremiumButton variant="danger" style={{ padding: "6px 12px", fontSize: "12px" }} onClick={() => onDelete(memory.recordId)}>
            Delete
          </PremiumButton>
        </div>
      </div>

      <p style={{ margin: 0, color: "var(--color-white-frost)", fontSize: "14px", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {memory.content}
      </p>

      <div style={{ height: "4px", borderRadius: "9999px", background: "rgba(226,227,233,0.1)", overflow: "hidden" }}>
        <div style={{ width: `${priority}%`, height: "100%", background: "var(--color-golden-gradient)" }} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", color: "var(--color-silver-text)", fontSize: "12px" }}>
        <MemoryBadge score={memory.neverCitedCount} />
        <span>{memory.citationCount} citations</span>
        {memory.neverCitedCount > 0 && <span>{memory.neverCitedCount} uncited recalls</span>}
        <span>{new Date(memory.createdTime).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
      </div>
    </motion.article>
  );
}
