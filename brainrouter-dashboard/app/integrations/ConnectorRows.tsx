"use client";

import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { StatusBadge } from "../../components/Analytics";
import { InlineLoading } from "../../components/LoadingSpinner";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type ConnectorAccount } from "../../lib/adminApi";
import {
  applyGithubDevicePoll,
  beginGithubDeviceFlow,
  shouldUseGithubDeviceFallback,
  type GithubDeviceFlowState,
} from "./githubDeviceFlow";

const GROUPS: Array<{ title: string; sources: Array<[string, string]> }> = [
  { title: "Code providers", sources: [["github", "GitHub"], ["gitlab", "GitLab"]] },
  { title: "Communication", sources: [["slack", "Slack"]] },
  { title: "Knowledge & issue tracking", sources: [["google-drive", "Google Drive"], ["gmail", "Gmail"], ["notion", "Notion"], ["linear", "Linear"]] },
];

type ResourceRow = { id: string; label: string; selected: boolean; kind?: string };
type SourceAuthMode = "web" | "device" | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The connector request failed.";
}

export function ConnectorRows({ orgId }: { orgId?: string }) {
  // Multi-account: each source owns a LIST of connectors (accounts). We still read
  // the single connectorStatus per source, but only to learn its authMode (device
  // vs web) which drives how a fresh account is connected. Resource selection,
  // errors and the expand state are all keyed by the specific account (connector
  // id), never the bare source — otherwise account #2 could never be managed and a
  // save would silently overwrite account #1.
  const [accounts, setAccounts] = useState<Record<string, ConnectorAccount[]>>({});
  const [authModes, setAuthModes] = useState<Record<string, SourceAuthMode>>({});
  const [resources, setResources] = useState<Record<string, ResourceRow[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(""); // a connector id
  const [adding, setAdding] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeGroup, setActiveGroup] = useState(GROUPS[0].title);
  const [githubDevice, setGithubDevice] = useState<GithubDeviceFlowState>({ status: "idle" });

  const load = useCallback(async () => {
    const sources = GROUPS.flatMap((group) => group.sources).map(([source]) => source);
    const results = await Promise.all(sources.map(async (source) => {
      const [accountsRes, status] = await Promise.all([
        adminApi.connectorAccounts(source, orgId).catch(() => null),
        adminApi.connectorStatus(source, orgId).catch(() => null),
      ]);
      return { source, accounts: accountsRes?.accounts ?? [], authMode: status?.authMode };
    }));
    setAccounts(Object.fromEntries(results.map((row) => [row.source, row.accounts] as const)));
    setAuthModes(Object.fromEntries(results.map((row) => [row.source, row.authMode] as const)));
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    setAccounts({});
    setAuthModes({});
    setErrors({});
    setExpanded("");
    setAdding("");
    setLoading(true);
    setGithubDevice({ status: "idle" });
    void load();
  }, [load]);

  useEffect(() => {
    if (githubDevice.status !== "pending") return;
    const pending = githubDevice;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const result = await adminApi.pollGithubDevice(orgId);
        if (cancelled) return;
        const next = applyGithubDevicePoll(pending, result);
        if (next.status === "pending") {
          timer = window.setTimeout(() => void poll(), pending.intervalMs);
          return;
        }
        if (next.status === "connected") {
          setGithubDevice({ status: "idle" });
          setErrors((current) => ({ ...current, github: "" }));
          await load();
          return;
        }
        setGithubDevice(next);
        setErrors((current) => ({ ...current, github: next.error }));
      } catch (error) {
        if (cancelled) return;
        const message = errorMessage(error);
        setGithubDevice({ status: "error", error: message });
        setErrors((current) => ({ ...current, github: message }));
      }
    };

    timer = window.setTimeout(() => void poll(), pending.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [githubDevice, load, orgId]);

  // Errors are keyed by source (source-level: connect / add account) or by
  // `acct:${connectorId}` (a specific account's action), so the source banner and
  // an account row never show two copies of the same failure.
  const accountKey = (connectorId: string): string => `acct:${connectorId}`;
  const start = (key: string, action: string): void => {
    setBusy(`${key}:${action}`);
    setErrors((current) => ({ ...current, [key]: "" }));
  };
  const fail = (key: string, error: unknown): void => {
    setErrors((current) => ({ ...current, [key]: errorMessage(error) }));
  };

  async function startGithubDeviceFlow(connectorId?: string): Promise<void> {
    const next = beginGithubDeviceFlow(await adminApi.startGithubDevice(orgId, connectorId));
    if (next.status === "error") throw new Error(next.error);
    setGithubDevice(next);
  }

  // Start (or resume) the connect flow bound to a specific account/connector id.
  // GitHub in device mode goes straight to the device flow; everyone else uses the
  // web OAuth broker, with a 409 still falling back to GitHub device flow.
  async function beginConnect(source: string, connectorId: string): Promise<void> {
    if (source === "github" && authModes.github === "device") {
      await startGithubDeviceFlow(connectorId);
      return;
    }
    try {
      const result = await adminApi.startConnectorOAuth(source, connectorId, orgId);
      window.location.assign(result.url);
    } catch (error) {
      if (source === "github" && shouldUseGithubDeviceFallback(error)) {
        await startGithubDeviceFlow(connectorId);
      } else {
        throw error;
      }
    }
  }

  // Resume the connect flow for an existing (pending) account.
  async function connectAccount(source: string, connectorId: string): Promise<void> {
    start(accountKey(connectorId), "connect");
    try {
      await beginConnect(source, connectorId);
    } catch (error) {
      fail(accountKey(connectorId), error);
    } finally {
      setBusy("");
    }
  }

  // Create a brand-new empty account for a source, then start its connect flow
  // bound to the returned connector id. Used both for the first account and for
  // "Add another account". On any failure we still reload so the just-created
  // (now un-authorized) account is visible to retry or remove — never orphaned.
  async function startNewAccount(source: string, label: string): Promise<void> {
    start(source, "connect");
    try {
      const { connector } = await adminApi.addConnectorAccount(source, label.trim(), orgId);
      setAdding("");
      setLabelDraft("");
      await load();
      await beginConnect(source, connector.id);
    } catch (error) {
      fail(source, error);
      await load();
    } finally {
      setBusy("");
    }
  }

  async function cancelGithubDevice(): Promise<void> {
    setGithubDevice({ status: "idle" });
    start("github", "cancel");
    try {
      await adminApi.cancelGithubDevice(orgId);
      await load();
    } catch (error) {
      fail("github", error);
    } finally {
      setBusy("");
    }
  }

  async function removeAccount(source: string, connectorId: string): Promise<void> {
    start(accountKey(connectorId), "disconnect");
    try {
      await adminApi.deleteConnectorAccount(connectorId, orgId);
      if (expanded === connectorId) setExpanded("");
      await load();
    } catch (error) {
      fail(accountKey(connectorId), error);
    } finally {
      setBusy("");
    }
  }

  async function toggleResources(source: string, connectorId: string): Promise<void> {
    if (expanded === connectorId) {
      setExpanded("");
      return;
    }
    start(accountKey(connectorId), "resources");
    try {
      const result = await adminApi.connectorResources(source, connectorId, orgId);
      setResources((current) => ({ ...current, [connectorId]: result.resources }));
      setExpanded(connectorId);
    } catch (error) {
      fail(accountKey(connectorId), error);
    } finally {
      setBusy("");
    }
  }

  async function persistResources(source: string, connectorId: string, rows: ResourceRow[]): Promise<void> {
    start(accountKey(connectorId), "save");
    try {
      await adminApi.setConnectorResources(
        source,
        connectorId,
        rows.filter((row) => row.selected).map((row) => row.id),
        orgId,
      );
      setExpanded("");
      await load();
    } catch (error) {
      fail(accountKey(connectorId), error);
    } finally {
      setBusy("");
    }
  }

  async function syncNow(source: string, connectorId: string): Promise<void> {
    start(accountKey(connectorId), "sync");
    try {
      const { result } = await adminApi.runConnector(connectorId, orgId);
      if (!result.ok) throw new Error(result.error || "The connector sync did not complete.");
      await load();
    } catch (error) {
      fail(accountKey(connectorId), error);
      await load();
    } finally {
      setBusy("");
    }
  }

  async function setScheduled(source: string, connectorId: string, enabled: boolean): Promise<void> {
    start(accountKey(connectorId), "schedule");
    try {
      await adminApi.setConnectorSchedule(connectorId, enabled, orgId);
      await load();
    } catch (error) {
      fail(accountKey(connectorId), error);
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
    setAdding("");
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
            onClick={() => { setActiveGroup(candidate.title); setExpanded(""); setAdding(""); }}
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
        {loading ? (
          <InlineLoading label="Loading connections…" />
        ) : group.sources.map(([source, label]) => {
          const sourceAccounts = accounts[source] ?? [];
          const connectedCount = sourceAccounts.filter((account) => account.connected).length;
          const anyConnected = connectedCount > 0;
          const sourceBusy = busy.startsWith(`${source}:`);
          const waitingForGithub = source === "github" && githubDevice.status === "pending";
          const sourceError = errors[source] || "";
          return (
            <div className="connector-resource" key={source}>
              <div className="settings-item">
                <div>
                  <div className="settings-row__title">{label}</div>
                  <div className="settings-row__sub">
                    {anyConnected
                      ? `${connectedCount} account${connectedCount === 1 ? "" : "s"} connected`
                      : "No accounts connected yet"}
                  </div>
                  {sourceError && <div className="connector-resource__error" role="alert">Last error: {sourceError}</div>}
                </div>
                <div className="settings-actions">
                  <StatusBadge tone={anyConnected ? "ok" : "neutral"}>{anyConnected ? "Connected" : "Not connected"}</StatusBadge>
                  {sourceAccounts.length === 0 ? (
                    <PremiumButton
                      size="small"
                      variant="ghost"
                      disabled={sourceBusy || waitingForGithub}
                      onClick={() => void startNewAccount(source, "")}
                    >
                      {waitingForGithub ? "Waiting…" : busy === `${source}:connect` ? "Working…" : "Connect"}
                    </PremiumButton>
                  ) : (
                    <PremiumButton
                      size="small"
                      variant="ghost"
                      disabled={sourceBusy || waitingForGithub}
                      onClick={() => { setAdding(adding === source ? "" : source); setLabelDraft(""); }}
                    >
                      {adding === source ? "Close" : "Add another account"}
                    </PremiumButton>
                  )}
                </div>
              </div>
              {adding === source && (
                <div className="connector-resource__picker">
                  <div className="settings-row__title">Add another account</div>
                  <div className="settings-hint">Give it a label to tell your accounts apart (optional), then authorize the new account.</div>
                  <input
                    type="text"
                    className="settings-input"
                    value={labelDraft}
                    placeholder="e.g. Work"
                    aria-label={`New ${label} account label`}
                    style={{ maxWidth: 320 }}
                    onChange={(event) => setLabelDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); void startNewAccount(source, labelDraft); }
                    }}
                  />
                  <div className="connector-resource__actions">
                    <PremiumButton
                      size="small"
                      variant="primary"
                      disabled={sourceBusy || waitingForGithub}
                      onClick={() => void startNewAccount(source, labelDraft)}
                    >
                      {busy === `${source}:connect` ? "Working…" : "Connect account"}
                    </PremiumButton>
                    <PremiumButton size="small" variant="text" disabled={sourceBusy} onClick={() => { setAdding(""); setLabelDraft(""); }}>Cancel</PremiumButton>
                  </div>
                </div>
              )}
              {sourceAccounts.map((account) => {
                const acctBusy = busy.startsWith(`${accountKey(account.id)}:`);
                const acctError = errors[accountKey(account.id)] || "";
                const rows = resources[account.id] ?? [];
                const selectable = source !== "gmail";
                return (
                  <div key={account.id}>
                    <div className="settings-item">
                      <div>
                        <div className="settings-row__title">{account.label || label}</div>
                        <div className="settings-row__sub">
                          {account.connected
                            ? account.account
                              ? `@${account.account}`
                              : "Connected — ready to sync"
                            : "Awaiting authorization"}
                        </div>
                        {account.connected && (
                          <div className="settings-row__sub">
                            {account.lastRunAt ? `Last sync ${new Date(account.lastRunAt).toLocaleString()}` : "Not synced yet"}
                            {" · "}
                            {account.enabled ? "automatic sync on" : "paused"}
                          </div>
                        )}
                        {acctError
                          ? <div className="connector-resource__error" role="alert">Last error: {acctError}</div>
                          : account.lastError && <div className="connector-resource__error" role="alert">Last sync error: {account.lastError}</div>}
                      </div>
                      <div className="settings-actions">
                        <StatusBadge tone={account.connected ? "ok" : "neutral"}>{account.connected ? "Connected" : "Pending"}</StatusBadge>
                        {account.connected ? (
                          <>
                            <PremiumButton
                              size="small"
                              variant="text"
                              disabled={acctBusy}
                              onClick={() => void toggleResources(source, account.id)}
                            >
                              {busy === `${accountKey(account.id)}:resources`
                                ? "Loading…"
                                : expanded === account.id
                                  ? "Close"
                                  : source === "gmail"
                                    ? "View labels"
                                    : "Choose resources"}
                            </PremiumButton>
                            <PremiumButton
                              size="small"
                              variant="text"
                              disabled={acctBusy}
                              onClick={() => void syncNow(source, account.id)}
                            >
                              {busy === `${accountKey(account.id)}:sync` ? "Syncing…" : "Sync now"}
                            </PremiumButton>
                            <PremiumButton
                              size="small"
                              variant="text"
                              disabled={acctBusy}
                              aria-pressed={account.enabled}
                              onClick={() => void setScheduled(source, account.id, !account.enabled)}
                            >
                              {busy === `${accountKey(account.id)}:schedule`
                                ? "Saving…"
                                : account.enabled
                                  ? "Pause schedule"
                                  : "Resume schedule"}
                            </PremiumButton>
                          </>
                        ) : (
                          <PremiumButton
                            size="small"
                            variant="primary"
                            disabled={acctBusy || waitingForGithub}
                            onClick={() => void connectAccount(source, account.id)}
                          >
                            {waitingForGithub ? "Waiting…" : busy === `${accountKey(account.id)}:connect` ? "Working…" : "Connect"}
                          </PremiumButton>
                        )}
                        <PremiumButton
                          size="small"
                          variant="danger"
                          disabled={acctBusy || waitingForGithub}
                          onClick={() => void removeAccount(source, account.id)}
                        >
                          {busy === `${accountKey(account.id)}:disconnect` ? "Removing…" : "Disconnect"}
                        </PremiumButton>
                      </div>
                    </div>
                    {expanded === account.id && (
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
                                  [account.id]: rows.map((candidate) => candidate.id === row.id
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
                            <PremiumButton size="small" variant="primary" disabled={acctBusy} onClick={() => void persistResources(source, account.id, rows)}>
                              {busy === `${accountKey(account.id)}:save` ? "Saving…" : "Save selection"}
                            </PremiumButton>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {waitingForGithub && (
                <div className="connector-resource__picker" role="status" aria-label="GitHub device authorization">
                  <div className="settings-row__title">Complete GitHub authorization</div>
                  <div className="settings-hint">Enter this one-time code on GitHub. BrainRouter will finish automatically and keep the resulting token sealed on the backend.</div>
                  <code aria-label="GitHub device code" style={{ display: "inline-block", marginTop: 8, fontSize: "1.1rem", letterSpacing: "0.08em" }}>{githubDevice.userCode}</code>
                  <div className="connector-resource__actions">
                    <PremiumButton size="small" variant="primary" onClick={() => window.open(githubDevice.verificationUri, "_blank", "noopener,noreferrer")}>Open GitHub</PremiumButton>
                    <PremiumButton size="small" variant="text" disabled={busy === "github:cancel"} onClick={() => void cancelGithubDevice()}>{busy === "github:cancel" ? "Cancelling…" : "Cancel"}</PremiumButton>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
