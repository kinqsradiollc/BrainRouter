"use client";

import { useEffect } from "react";
import {
  NotesMode,
  isQuickFindShortcut,
} from "@kinqs/brainrouter-ui/notes";
import "@kinqs/brainrouter-ui/notes.css";

import { AuthGuard } from "../../components/AuthGuard";
import { InlineLoading } from "../../components/LoadingSpinner";
import { PageHeader } from "../../components/PageHeader";
import { useDashboardNotes } from "./useDashboardNotes";

export default function NotesPage() {
  return (
    <AuthGuard>
      <DashboardNotes />
    </AuthGuard>
  );
}
function DashboardNotes() {
  const notes = useDashboardNotes();

  /** The route owns only the global binding; the shared key contract decides
   *  whether a keyboard event means quick find. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isQuickFindShortcut(event)) return;
      event.preventDefault();
      notes.ops.openQuickFind();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [notes.ops]);

  return (
    <div className="settings-page" style={{ display: "flex", minHeight: "calc(100dvh - 220px)", flexDirection: "column" }}>
      <PageHeader
        title="Notes"
        description="Your pages and databases, with the same editor and interactions on web and desktop."
      />
      {notes.error ? <div className="settings-note settings-note--error" role="alert">{notes.error}</div> : null}
      {notes.capabilityNotices.map((notice) => (
        <div key={notice} className="settings-note settings-note--warn" role="status">{notice}</div>
      ))}
      {notes.loading && notes.blocks.length === 0 ? <InlineLoading label="Loading Notes…" /> : (
        <NotesMode
          blocks={notes.blocks}
          repairs={notes.repairs}
          syncState={notes.syncState}
          revision={notes.revision}
          refLabels={notes.refLabels}
          files={notes.files}
          symbols={notes.symbols}
          matchIds={notes.matchIds}
          backlinkCounts={notes.backlinkCounts}
          shell={notes.shell}
          ops={notes.ops}
        />
      )}
    </div>
  );
}
