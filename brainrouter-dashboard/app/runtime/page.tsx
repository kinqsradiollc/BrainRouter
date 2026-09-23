"use client";

// ADR-041 D14 (glass box, commitment #5) — the composition panel. Shows *what is
// running*: the resolved runtime composition (built-in tools, the D8-migrated
// handler set, live providers, extension contributions, slash commands, the
// runtime-invariant areas + any live violations, and the active loop-driver /
// execution-world rows) — the same projection `--dump-composition` prints, made
// visible to an operator.

import { useCallback, useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { InlineLoading } from "../../components/LoadingSpinner";
import { EmptyState } from "../../components/EmptyState";
import { adminApi, type RuntimeComposition } from "../../lib/adminApi";
import { queryDashboard } from "../../lib/dashboardQuery";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";

function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="runtime-muted">none</span>;
  return (
    <div className="runtime-chips">
      {items.map((name) => (
        <code key={name} className="runtime-chip">{name}</code>
      ))}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <PremiumCard>
      <div className="runtime-section-head">
        <h2 className="runtime-section-title">{title}</h2>
        {count !== undefined && <span className="runtime-count">{count}</span>}
      </div>
      {children}
    </PremiumCard>
  );
}

export default function RuntimeCompositionPage() {
  const { activeOrgId } = useActiveOrg();
  const [data, setData] = useState<RuntimeComposition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await queryDashboard(
        `runtime-composition:${activeOrgId}`,
        () => adminApi.getRuntimeComposition(activeOrgId || undefined),
        { ttlMs: 15_000 },
      );
      setData(snap);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the runtime composition.");
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AuthGuard>
      <div className="runtime-page">
        <PageHeader
          title="Runtime"
          description="What the agent runtime is composed of — the plug-and-play surfaces that are live right now (ADR-041 D14)."
        />

        {loading && !data && <InlineLoading label="Reading the composition…" />}
        {error && !data && (
          <EmptyState title="Couldn't read the composition" description={error} />
        )}

        {data && (
          <div className="runtime-grid">
            <Section title="Runtime rows">
              <dl className="runtime-kv">
                <div><dt>Loop driver</dt><dd><code className="runtime-chip">{data.loopDriver}</code></dd></div>
                {data.executionWorld && (
                  <div><dt>Execution world</dt><dd><code className="runtime-chip">{data.executionWorld}</code></dd></div>
                )}
                <div>
                  <dt>Invariant violations</dt>
                  <dd className={data.invariants.violations > 0 ? "runtime-bad" : "runtime-ok"}>
                    {data.invariants.violations}
                  </dd>
                </div>
                <div>
                  <dt>Tripwire firings</dt>
                  <dd className={(data.invariants.runtimeReports?.reduce((n, r) => n + r.count, 0) ?? 0) > 0 ? "runtime-bad" : "runtime-ok"}>
                    {data.invariants.runtimeReports?.reduce((n, r) => n + r.count, 0) ?? 0}
                  </dd>
                </div>
              </dl>
            </Section>

            <Section title="Providers" count={data.providers.length}>
              <Chips items={data.providers} />
            </Section>

            <Section title="Built-in tools" count={data.builtinTools.length}>
              <p className="runtime-note">
                {data.migratedBuiltinTools.length} dispatched through the D8 handler registry.
              </p>
              <Chips items={data.builtinTools} />
            </Section>

            <Section title="Extensions">
              <p className="runtime-note">
                {data.extensions.tools.length} tools · {data.extensions.providers.length} providers ·{" "}
                {data.extensions.hooks} hooks · {data.extensions.panels.length} panels
              </p>
              <Chips items={[...data.extensions.tools, ...data.extensions.providers, ...data.extensions.panels]} />
            </Section>

            <Section title="Slash commands" count={data.slashCommands.length}>
              <Chips items={data.slashCommands} />
            </Section>

            <Section title="Runtime invariants" count={data.invariants.areas.length}>
              <ul className="runtime-invariants">
                {data.invariants.areas.map((area) => (
                  <li key={area.area}>
                    <strong>{area.area}</strong>
                    {area.invariants.length > 0 ? (
                      <span className="runtime-muted"> — {area.invariants.join(", ")}</span>
                    ) : (
                      <span className="runtime-muted"> — {area.emptyReason ?? "no invariants declared"}</span>
                    )}
                  </li>
                ))}
              </ul>
              {data.invariants.runtimeReports && data.invariants.runtimeReports.length > 0 && (
                <div className="runtime-tripwires">
                  <h3 className="runtime-subhead">Tripwires fired this process (ADR-046)</h3>
                  <ul className="runtime-invariants">
                    {data.invariants.runtimeReports.map((r) => (
                      <li key={r.id}>
                        <strong>{r.id}</strong>
                        <span className="runtime-bad"> — fired {r.count}×</span>
                      </li>
                    ))}
                  </ul>
                  <p className="runtime-muted">
                    A tripwire firing means recorded state had to be repaired to reach the model —
                    it should stay at zero. Advisory only; not a verify-gate violation.
                  </p>
                </div>
              )}
            </Section>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
