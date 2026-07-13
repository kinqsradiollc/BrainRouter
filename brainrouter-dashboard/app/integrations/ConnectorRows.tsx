"use client";

import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { StatusBadge } from "../../components/Analytics";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type ConnectorStatus } from "../../lib/adminApi";

const GROUPS: Array<{ title: string; sources: Array<[string, string]> }> = [
  { title: "Code providers", sources: [["github", "GitHub"], ["gitlab", "GitLab"]] },
  { title: "Communication", sources: [["slack", "Slack"]] },
  { title: "Knowledge & issue tracking", sources: [["google-drive", "Google Drive"], ["gmail", "Gmail"], ["notion", "Notion"], ["linear", "Linear"]] },
];

type ResourceRow = { id: string; label: string; selected: boolean; kind?: string };
type ConnectorAction = "connect" | "disconnect" | "resources" | "save" | "sync" | "schedule";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The connector request failed.";
}

export function ConnectorRows({ orgId }: { orgId?: string }) {
  const [state, setState] = useState<Record<string, ConnectorStatus | null>>({});
  const [resources, setResources] = useState<Record<string, ResourceRow[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState("");
  const [busy, setBusy] = useState("");
  const [activeGroup, setActiveGroup] = useState(GROUPS[0].title);

  const load = useCallback(async () => {
    const entries = await Promise.all(GROUPS.flatMap((group) => group.sources).map(async ([source]) => [
      source,
      await adminApi.connectorStatus(source, orgId).catch(() => null),
    ] as const));
    setState(Object.fromEntries(entries));
  }, [orgId]);

  useEffect(() => {
    setState({});
    setErrors({});
    setExpanded("");
    void load();
  }, [load]);

  const start = (source: string, action: ConnectorAction): void => {
    setBusy(`${source}:${action}`);
    setErrors((current) => ({ ...current, [source]: "" }));
  };
  const fail = (source: string, error: unknown): void => {
    setErrors((current) => ({ ...current, [source]: errorMessage(error) }));
  };

  async function connect(source: string): Promise<void> {
    start(source, "connect");
    try {
      const result = await adminApi.startConnectorOAuth(source, state[source]?.connector?.id, orgId);
      window.location.assign(result.url);
    } catch (error) {
      fail(source, error);
    } finally {
      setBusy("");
    }
  }

  async function disconnect(source: string): Promise<void> {
    start(source, "disconnect");
    try {
      await adminApi.disconnectConnector(source, orgId);
      setExpanded("");
      await load();
    } catch (error) {
      fail(source, error);
    } finally {
      setBusy("");
    }
  }

  async function toggleResources(source: string): Promise<void> {
    if (expanded === source) {
      setExpanded("");
      return;
    }
    start(source, "resources");
    try {
      const result = await adminApi.connectorResources(source, orgId);
      setResources((current) => ({ ...current, [source]: result.resources }));
      setExpanded(source);
    } catch (error) {
      fail(source, error);
    } finally {
      setBusy("");
    }
  }

  async function persistResources(source: string, rows: ResourceRow[]): Promise<void> {
    start(source, "save");
    try {
      await adminApi.setConnectorResources(
        source,
        rows.filter((row) => row.selected).map((row) => row.id),
        orgId,
      );
      setExpanded("");
      await load();
    } catch (error) {
      fail(source, error);
    } finally {
      setBusy("");
    }
  }

  async function syncNow(source: string, connectorId: string): Promise<void> {
    start(source, "sync");
    try {
      const { result } = await adminApi.runConnector(connectorId, orgId);
      if (!result.ok) throw new Error(result.error || "The connector sync did not complete.");
      await load();
    } catch (error) {
      fail(source, error);
      await load();
    } finally {
      setBusy("");
    }
  }

  async function setScheduled(source: string, connectorId: string, enabled: boolean): Promise<void> {
    start(source, "schedule");
    try {
      await adminApi.setConnectorSchedule(connectorId, enabled, orgId);
      await load();
    } catch (error) {
      fail(source, error);
    } finally {
      setBusy("");
    }
  }

  const group = GROUPS.find((candidate) => candidate.title === activeGroup) ?? GROUPS[0];
  const activeGroupIndex = Math.max(0, GROUPS.indexOf(group));
  const moveGroup = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % GROUPS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + GROUPS.length) % GROUPS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = GROUPS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveGroup(GROUPS[nextIndex].title);
    setExpanded("");
    requestAnimationFrame(() => document.getElementById(`connection-group-tab-${nextIndex}`)?.focus());
  };

  return (
    <div className="settings-stack" style={{ marginTop: "var(--spacing-16)" }}>
      <div className="settings-provider-tabs" role="tablist" aria-label="Connection type">
        {GROUPS.map((candidate, index) => (
          <button
            key={candidate.title}
            type="button"
            role="tab"
            id={`connection-group-tab-${index}`}
            aria-controls={`connection-group-panel-${index}`}
            aria-selected={candidate.title === activeGroup}
            tabIndex={candidate.title === activeGroup ? 0 : -1}
            className={candidate.title === activeGroup ? "active" : ""}
            onKeyDown={(event) => moveGroup(event, index)}
            onClick={() => { setActiveGroup(candidate.title); setExpanded(""); }}
          >
            {candidate.title}
          </button>
        ))}
      </div>
      <section
        id={`connection-group-panel-${activeGroupIndex}`}
        role="tabpanel"
        aria-labelledby={`connection-group-tab-${activeGroupIndex}`}
        className="analytics-panel"
      >
        <h2>{group.title}</h2>
        {group.sources.map(([source, label]) => {
          const item = state[source];
          const connector = item?.connector;
          const connected = !!item?.connected;
          const rows = resources[source] ?? [];
          const selectable = source !== "gmail";
          const isBusy = busy.startsWith(`${source}:`);
          const error = errors[source] || connector?.lastError || "";
          return (
            <div className="connector-resource" key={source}>
              <div className="settings-item">
                <div>
                  <div className="settings-row__title">{label}</div>
                  <div className="settings-row__sub">
                    {connected
                      ? connector?.lastRunAt
                        ? `Last sync ${new Date(connector.lastRunAt).toLocaleString()}`
                        : "Connected — ready to sync"
                      : "Connect a server-sealed account"}
                  </div>
                  {connector && (
                    <div className="settings-row__sub">
                      Schedule: {connector.enabled ? "automatic sync on" : "paused"}
                    </div>
                  )}
                  {error && <div className="connector-resource__error" role="alert">Last error: {error}</div>}
                </div>
                <div className="settings-actions">
                  <StatusBadge tone={connected ? "ok" : "neutral"}>{connected ? "Connected" : "Not connected"}</StatusBadge>
                  {connected && connector && (
                    <>
                      <PremiumButton
                        size="small"
                        variant="text"
                        disabled={isBusy}
                        onClick={() => void syncNow(source, connector.id)}
                      >
                        {busy === `${source}:sync` ? "Syncing…" : "Sync now"}
                      </PremiumButton>
                      <PremiumButton
                        size="small"
                        variant="text"
                        disabled={isBusy}
                        aria-pressed={connector.enabled}
                        onClick={() => void setScheduled(source, connector.id, !connector.enabled)}
                      >
                        {busy === `${source}:schedule`
                          ? "Saving…"
                          : connector.enabled
                            ? "Pause schedule"
                            : "Resume schedule"}
                      </PremiumButton>
                    </>
                  )}
                  {connected && (
                    <PremiumButton size="small" variant="text" disabled={isBusy} onClick={() => void toggleResources(source)}>
                      {expanded === source ? "Close" : source === "gmail" ? "View labels" : "Choose resources"}
                    </PremiumButton>
                  )}
                  <PremiumButton
                    size="small"
                    variant={connected ? "danger" : "ghost"}
                    disabled={isBusy}
                    onClick={() => connected ? void disconnect(source) : void connect(source)}
                  >
                    {busy === `${source}:${connected ? "disconnect" : "connect"}` ? "Working…" : connected ? "Disconnect" : "Connect"}
                  </PremiumButton>
                </div>
              </div>
              {expanded === source && (
                <div className="connector-resource__picker">
                  {rows.length === 0
                    ? <div className="settings-hint">No resources were returned by this account.</div>
                    : rows.map((row) => (
                      <label className="settings-check" key={row.id}>
                        <input
                          type="checkbox"
                          disabled={!selectable}
                          checked={row.selected}
                          onChange={(event) => setResources((current) => ({
                            ...current,
                            [source]: rows.map((candidate) => candidate.id === row.id
                              ? { ...candidate, selected: event.target.checked }
                              : candidate),
                          }))}
                        />
                        <span>{row.label}</span>
                        {row.kind && <small>{row.kind}</small>}
                      </label>
                    ))}
                  {selectable && rows.length > 0 && (
                    <div className="connector-resource__actions">
                      <PremiumButton size="small" variant="primary" disabled={isBusy} onClick={() => void persistResources(source, rows)}>
                        {busy === `${source}:save` ? "Saving…" : "Save selection"}
                      </PremiumButton>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
