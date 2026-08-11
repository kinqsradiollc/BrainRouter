/**
 * ADR-038 — Dashboard adapter for the shared Planner presentation.
 * Dashboard owns authenticated transport; the shared UI package owns every
 * visible Planner interaction and layout used by both product hosts.
 */
"use client";

import { PlannerSurface } from "@kinqs/brainrouter-ui/planner";

import { AuthGuard } from "../../components/AuthGuard";
import { InlineLoading } from "../../components/LoadingSpinner";
import { PageHeader } from "../../components/PageHeader";
import styles from "./planner.module.css";
import { useDashboardPlanner } from "./useDashboardPlanner";

export default function PlannerPage() {
  return (
    <AuthGuard>
      <DashboardPlanner />
    </AuthGuard>
  );
}

function DashboardPlanner() {
  const planner = useDashboardPlanner();
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return (
    <div className={styles.page}>
      <PageHeader
        title="Planner"
        description="Your day across every project, with the same interactions on web and desktop."
      />
      {planner.error ? <div className={styles.error} role="status">{planner.error}</div> : null}
      {planner.loading && planner.items.length === 0 ? <InlineLoading /> : (
        <PlannerSurface
          items={planner.items}
          blocks={planner.blocks}
          today={today}
          sync={planner.sync}
          staleSources={planner.staleSources}
          driftNote={null}
          ops={planner.ops}
        />
      )}
    </div>
  );
}
