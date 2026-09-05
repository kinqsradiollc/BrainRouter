/**
 * DESK-5 — the Worktrees panel: sibling checkouts under `.worktrees/` so an
 * agent can run in one without touching your main checkout. List, create,
 * open (switch this window), inline-diff, and remove.
 */
import React, { useState } from 'react';
import { Icon } from '../../icons.js';
import { DiffView } from '../diff.js';
import { Button } from '../../components/primitives/Button.js';
import { type WorktreeEntry } from '../../lib/worktree/worktreeParser.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import { usePanelPolling } from '../../lib/panels/usePanelPolling.js';

type FanoutCandidateView = {
  id: string; adapterId: string; status: string; worktreeRoot?: string; terminalId?: string;
  executionHostId?: string; changedFiles: number; diffSummary?: string; score?: number; rank?: number; error?: string;
};
type FanoutRunView = {
  id: string; task: string; status: string; candidates: FanoutCandidateView[]; winnerId?: string;
  promotion?: { mode: string; ok: boolean; url?: string; error?: string };
};
type AdapterView = { id: string; label: string; installed: boolean; requiresWorkspaceTrust: boolean };
type RelayStatusView = {
  running: boolean; endpoints: string[]; connectedDevices: number;
  devices: Array<{ id: string; name: string; scopes: string[]; lastSeenAt?: string }>;
};
type SshHostView = {
  id: string; label: string; host: string; port: number; username: string;
  workspaceRoot: string; hostKeySha256: string;
};

export function WorktreesPanel({ worktrees, diffs, onCreate, onRemove, onOpen, onDiff, active = true }: {
  worktrees: WorktreeEntry[];
  diffs: Record<string, string>;
  onCreate: (name: string, ref: string) => void;
  onRemove: (path: string) => void;
  onOpen: (path: string) => void;
  onDiff: (path: string) => void;
  active?: boolean;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [fanoutRuns, setFanoutRuns] = useState<FanoutRunView[]>([]);
  const [fanoutTask, setFanoutTask] = useState('');
  const [fanoutAdapters, setFanoutAdapters] = useState<AdapterView[]>([]);
  const [pickedAdapters, setPickedAdapters] = useState<string[]>([]);
  const [fanoutTrusted, setFanoutTrusted] = useState(false);
  const [fanoutBusy, setFanoutBusy] = useState(false);
  const [fanoutError, setFanoutError] = useState('');
  const [terminalSnapshots, setTerminalSnapshots] = useState<Record<string, string>>({});
  const [followups, setFollowups] = useState<Record<string, string>>({});
  const [relay, setRelay] = useState<RelayStatusView>({ running: false, endpoints: [], connectedDevices: 0, devices: [] });
  const [relayLan, setRelayLan] = useState(false);
  const [relayApprove, setRelayApprove] = useState(false);
  const [pairing, setPairing] = useState<{ qrDataUrl: string; payload: { expiresAt: string } } | null>(null);
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayError, setRelayError] = useState('');
  const [sshHosts, setSshHosts] = useState<SshHostView[]>([]);
  const [executionHostId, setExecutionHostId] = useState('local');
  const [sshDraft, setSshDraft] = useState({ label: '', host: '', port: '22', username: '', workspaceRoot: '', hostKeySha256: '' });
  const [sshBusy, setSshBusy] = useState(false);
  const [sshError, setSshError] = useState('');
  const [sshProbe, setSshProbe] = useState<Record<string, string>>({});

  const refreshFanout = React.useCallback(async () => {
    try {
      const runs = await bridgeQuery<FanoutRunView[]>('fanout-list', {}, 15_000);
      setFanoutRuns(Array.isArray(runs) ? runs : []);
      const attached = (Array.isArray(runs) ? runs : []).flatMap((run) => run.candidates.filter((candidate) => candidate.terminalId));
      const snapshots = await Promise.all(attached.map(async (candidate) => {
        try {
          const result = await bridgeQuery<{ snapshot?: string }>('fanout-terminal', { candidateId: candidate.id }, 5_000);
          return [candidate.id, result?.snapshot ?? ''] as const;
        } catch { return [candidate.id, ''] as const; }
      }));
      setTerminalSnapshots((current) => ({ ...current, ...Object.fromEntries(snapshots) }));
    } catch (error) { setFanoutError((error as Error).message || 'Fan-out refresh failed.'); }
  }, []);

  const refreshRelay = React.useCallback(async (): Promise<void> => {
    try {
      setRelay(await bridgeQuery<RelayStatusView>('mobile-relay-status', {}, 5_000));
    } catch {
      // Relay status is advisory; retain the last known state on a transient failure.
    }
  }, []);

  const refreshSshHosts = React.useCallback(() => {
    void bridgeQuery<SshHostView[]>('ssh-host-list', {}, 10_000).then((hosts) => {
      const next = Array.isArray(hosts) ? hosts : [];
      setSshHosts(next);
      setExecutionHostId((current) => current === 'local' || next.some((host) => host.id === current) ? current : 'local');
    }).catch(() => setSshHosts([]));
  }, []);

  const refreshFanoutAdapters = React.useCallback(() => {
    void bridgeQuery<{ adapters: AdapterView[] }>('hosted-agent-catalog', {}, 10_000).then((result) => {
      const adapters = result.adapters ?? [];
      const installed = adapters.filter((adapter) => adapter.installed);
      setFanoutAdapters(adapters);
      setPickedAdapters((current) => (
        current.length ? current.filter((id) => installed.some((adapter) => adapter.id === id))
          : installed.slice(0, Math.min(3, installed.length)).map((adapter) => adapter.id)
      ));
    }).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!active) return;
    refreshFanoutAdapters();
    refreshSshHosts();
    // A persisted open panel can mount while the Desktop host is still
    // registering queries. Retry once instead of leaving an empty adapter list.
    const adapterRetry = window.setTimeout(refreshFanoutAdapters, 1_500);
    return () => window.clearTimeout(adapterRetry);
  }, [active, refreshFanoutAdapters, refreshSshHosts]);
  usePanelPolling({ active, intervalMs: 2_000, refresh: refreshFanout });
  usePanelPolling({ active, intervalMs: 2_000, refresh: refreshRelay });

  const discoverSshKey = async (): Promise<void> => {
    setSshBusy(true); setSshError('');
    try {
      const result = await bridgeQuery<{ fingerprint: string }>('ssh-host-discover-key', {
        host: sshDraft.host, port: Number(sshDraft.port) || 22, username: sshDraft.username,
      }, 15_000);
      setSshDraft((current) => ({ ...current, hostKeySha256: result.fingerprint }));
    } catch (error) { setSshError((error as Error).message || 'Host-key discovery failed.'); }
    finally { setSshBusy(false); }
  };

  const saveSshHost = async (): Promise<void> => {
    setSshBusy(true); setSshError('');
    try {
      const saved = await bridgeQuery<SshHostView>('ssh-host-save', {
        ...sshDraft, port: Number(sshDraft.port) || 22,
      }, 10_000);
      const tested = await bridgeQuery<{ ok: boolean; gitVersion?: string; adapters?: string[]; error?: string }>('ssh-host-test', { id: saved.id }, 20_000);
      if (!tested.ok) throw new Error(tested.error || 'SSH host verification failed.');
      setSshProbe((current) => ({ ...current, [saved.id]: `${tested.gitVersion ?? 'Git ready'}${tested.adapters?.length ? ` · ${tested.adapters.join(', ')}` : ' · no agent CLI detected'}` }));
      setSshDraft({ label: '', host: '', port: '22', username: '', workspaceRoot: '', hostKeySha256: '' });
      setExecutionHostId(saved.id); refreshSshHosts();
    } catch (error) { setSshError((error as Error).message || 'Could not save the SSH host.'); }
    finally { setSshBusy(false); }
  };

  const testSshHost = async (id: string): Promise<void> => {
    setSshBusy(true); setSshError('');
    try {
      const tested = await bridgeQuery<{ ok: boolean; gitVersion?: string; adapters?: string[]; error?: string }>('ssh-host-test', { id }, 20_000);
      if (!tested.ok) throw new Error(tested.error || 'SSH host verification failed.');
      setSshProbe((current) => ({ ...current, [id]: `${tested.gitVersion ?? 'Git ready'}${tested.adapters?.length ? ` · ${tested.adapters.join(', ')}` : ' · no agent CLI detected'}` }));
    } catch (error) { setSshError((error as Error).message || 'SSH host test failed.'); }
    finally { setSshBusy(false); }
  };

  const relayAction = async (name: string, args: Record<string, unknown> = {}): Promise<void> => {
    setRelayBusy(true); setRelayError('');
    try {
      const result = await bridgeQuery<RelayStatusView>(name, args, 15_000);
      if (result && typeof result.running === 'boolean') setRelay(result);
      refreshRelay();
    } catch (error) { setRelayError((error as Error).message || 'Mobile relay action failed.'); }
    finally { setRelayBusy(false); }
  };

  const createPairing = async (): Promise<void> => {
    setRelayBusy(true); setRelayError('');
    try {
      const result = await bridgeQuery<{ qrDataUrl: string; payload: { expiresAt: string } }>('mobile-relay-pairing', { scopes: ['monitor', 'control', ...(relayApprove ? ['approve'] : [])] }, 10_000);
      setPairing(result);
    } catch (error) { setRelayError((error as Error).message || 'Pairing failed.'); }
    finally { setRelayBusy(false); }
  };

  const startFanout = async (): Promise<void> => {
    if (!fanoutTask.trim() || pickedAdapters.length < 2 || pickedAdapters.length > 8) return;
    setFanoutBusy(true); setFanoutError('');
    try {
      await bridgeQuery('fanout-start', { task: fanoutTask, adapterIds: pickedAdapters, trusted: fanoutTrusted, executionHostId }, 20_000);
      setFanoutTask('');
      await refreshFanout();
    } catch (error) { setFanoutError((error as Error).message || 'Fan-out launch failed.'); }
    finally { setFanoutBusy(false); }
  };

  const fanoutAction = async (name: string, args: Record<string, unknown>): Promise<void> => {
    setFanoutBusy(true); setFanoutError('');
    try { await bridgeQuery(name, args, 60_000); await refreshFanout(); }
    catch (error) { setFanoutError((error as Error).message || `${name} failed.`); }
    finally { setFanoutBusy(false); }
  };
  const submit = (): void => { if (name.trim()) { onCreate(name.trim(), ref.trim()); setName(''); setRef(''); } };
  const toggleDiff = (p: string): void => {
    const next = openPath === p ? null : p;
    setOpenPath(next);
    if (next && diffs[next] === undefined) onDiff(next);
  };
  const selectedFanoutAdapters = fanoutAdapters.filter((adapter) => pickedAdapters.includes(adapter.id));
  const trustRequiredAdapters = selectedFanoutAdapters.filter((adapter) => adapter.requiresWorkspaceTrust);
  const fanoutTrustMissing = trustRequiredAdapters.length > 0 && !fanoutTrusted;
  return (
    <div className="scroll wt-panel">
      <section className="mobile-relay-section">
        <div className="tasks-section"><span>Mobile steering</span><span className={`terminal-agent-status status-${relay.running ? 'working' : 'idle'}`}>{relay.running ? `${relay.connectedDevices} connected` : 'off'}</span></div>
        <div className="mobile-relay-card">
          <div className="mobile-relay-actions">
            {!relay.running ? <label><input type="checkbox" checked={relayLan} onChange={(event) => setRelayLan(event.target.checked)} /> Allow Tailscale / private LAN</label> : null}
            {!relay.running
              ? <Button disabled={relayBusy} onClick={() => void relayAction('mobile-relay-start', { lan: relayLan })}>Start encrypted relay</Button>
              : <Button variant="danger" disabled={relayBusy} onClick={() => { setPairing(null); void relayAction('mobile-relay-stop'); }}>Stop relay</Button>}
            {relay.running ? <label><input type="checkbox" checked={relayApprove} onChange={(event) => setRelayApprove(event.target.checked)} /> Allow approvals on new device</label> : null}
            {relay.running ? <Button disabled={relayBusy} onClick={() => void createPairing()}>Pair device</Button> : null}
          </div>
          {relay.endpoints.length ? <div className="sched-note">Encrypted endpoints: {relay.endpoints.join(' · ')}</div> : null}
          {relayError ? <div className="empty error">{relayError}</div> : null}
          {pairing ? <div className="mobile-pairing"><img src={pairing.qrDataUrl} alt="Encrypted mobile pairing QR code" /><div><strong>Scan in BrainRouter Mobile</strong><p>One-time code expires {new Date(pairing.payload.expiresAt).toLocaleTimeString()}.</p><p>The device key and token are exchanged inside a NaCl box.</p></div></div> : null}
          {relay.devices.map((device) => <div key={device.id} className="mobile-device-row"><div><strong>{device.name}</strong><span>{device.scopes.join(' · ')}{device.lastSeenAt ? ` · seen ${new Date(device.lastSeenAt).toLocaleString()}` : ''}</span></div><Button variant="danger" onClick={() => void relayAction('mobile-relay-revoke', { deviceId: device.id })}>Revoke</Button></div>)}
        </div>
      </section>
      <section className="fanout-section">
        <div className="tasks-section"><span>Parallel agent candidates</span><button className="tasks-clear" type="button" onClick={() => { refreshFanoutAdapters(); void refreshFanout(); }}>Refresh</button></div>
        <details className="ssh-hosts-card">
          <summary>Execution hosts <span>{executionHostId === 'local' ? 'Local' : sshHosts.find((host) => host.id === executionHostId)?.label ?? 'Remote'}</span></summary>
          <div className="ssh-host-list">
            <label className={`ssh-host-row${executionHostId === 'local' ? ' selected' : ''}`}><input type="radio" name="execution-host" checked={executionHostId === 'local'} onChange={() => setExecutionHostId('local')} /><span><strong>Local machine</strong><small>Native PTY · current checkout</small></span></label>
            {sshHosts.map((host) => <div key={host.id} className={`ssh-host-row${executionHostId === host.id ? ' selected' : ''}`}><label><input type="radio" name="execution-host" checked={executionHostId === host.id} onChange={() => setExecutionHostId(host.id)} /><span><strong>{host.label}</strong><small>{host.username}@{host.host}:{host.port} · {host.workspaceRoot}</small>{sshProbe[host.id] ? <small>{sshProbe[host.id]}</small> : null}</span></label><div className="ssh-host-actions"><Button disabled={sshBusy} onClick={() => void testSshHost(host.id)}>Test</Button><Button variant="danger" disabled={sshBusy} onClick={() => void bridgeQuery('ssh-host-remove', { id: host.id }, 10_000).then(refreshSshHosts)}>Remove</Button></div></div>)}
          </div>
          <div className="ssh-host-form">
            <input placeholder="Label" value={sshDraft.label} onChange={(event) => setSshDraft((current) => ({ ...current, label: event.target.value }))} />
            <input placeholder="Host or IP" value={sshDraft.host} onChange={(event) => setSshDraft((current) => ({ ...current, host: event.target.value, hostKeySha256: '' }))} />
            <input placeholder="Port" inputMode="numeric" value={sshDraft.port} onChange={(event) => setSshDraft((current) => ({ ...current, port: event.target.value, hostKeySha256: '' }))} />
            <input placeholder="SSH username" value={sshDraft.username} onChange={(event) => setSshDraft((current) => ({ ...current, username: event.target.value, hostKeySha256: '' }))} />
            <input className="ssh-host-wide" placeholder="Absolute remote checkout path" value={sshDraft.workspaceRoot} onChange={(event) => setSshDraft((current) => ({ ...current, workspaceRoot: event.target.value }))} />
            <div className="ssh-host-wide ssh-key-line"><code>{sshDraft.hostKeySha256 || 'Discover the server host key before saving'}</code><Button disabled={sshBusy || !sshDraft.host.trim() || !sshDraft.username.trim()} onClick={() => void discoverSshKey()}>Discover key</Button><Button disabled={sshBusy || !sshDraft.hostKeySha256 || !sshDraft.workspaceRoot.trim()} onClick={() => void saveSshHost()}>Save + verify</Button></div>
          </div>
          <div className="sched-note">Authentication uses your OS SSH agent. BrainRouter stores only this workspace path and the pinned server fingerprint—never a password or private key.</div>
          {sshError ? <div className="empty error">{sshError}</div> : null}
        </details>
        <div className="fanout-compose">
          <textarea value={fanoutTask} onChange={(event) => setFanoutTask(event.target.value)} placeholder="Describe one task to run across isolated candidates" rows={3} />
          <div className="fanout-adapters">
            {fanoutAdapters.map((adapter) => (
              <label key={adapter.id}><input type="checkbox" disabled={!adapter.installed} checked={pickedAdapters.includes(adapter.id)} onChange={(event) => {
                setPickedAdapters((current) => event.target.checked ? [...current, adapter.id] : current.filter((id) => id !== adapter.id));
              }} /> {adapter.label}{adapter.installed ? '' : ' (not installed)'}</label>
            ))}
          </div>
          <div className="fanout-compose-actions">
            <label><input type="checkbox" disabled={!trustRequiredAdapters.length} checked={fanoutTrusted} onChange={(event) => setFanoutTrusted(event.target.checked)} /> Trust isolated worktrees{trustRequiredAdapters.length ? ` for ${trustRequiredAdapters.map((adapter) => adapter.label).join(', ')}` : ''}</label>
            <Button onClick={() => void startFanout()} disabled={fanoutBusy || !fanoutTask.trim() || pickedAdapters.length < 2 || pickedAdapters.length > 8 || fanoutTrustMissing}>Run {pickedAdapters.length} candidates</Button>
          </div>
          {pickedAdapters.length < 2 ? <span className="sched-note">Choose at least two installed agents.</span> : null}
          {fanoutTrustMissing ? <span className="sched-note">Review and accept isolated-worktree trust before launching the selected adapters.</span> : null}
          {fanoutError ? <div className="empty error">{fanoutError}</div> : null}
        </div>
        {fanoutRuns.map((run) => (
          <div key={run.id} className="fanout-run">
            <div className="fanout-run-head">
              <div><strong>{run.task}</strong><span className="wt-tag">{run.status}</span></div>
              <Button onClick={() => void fanoutAction('fanout-rank', { runId: run.id })} disabled={fanoutBusy || run.status === 'failed'}>Compare + rank</Button>
            </div>
            <div className="fanout-grid">
              {run.candidates.map((candidate) => {
                const candidateActive = !!candidate.terminalId && !['done', 'failed'].includes(candidate.status);
                return (
                  <article key={candidate.id} className={`fanout-candidate${run.winnerId === candidate.id ? ' winner' : ''}`}>
                    <header><strong>{candidate.adapterId}</strong><span className={`terminal-agent-status status-${candidate.status}`}>{candidate.status}</span>{candidate.rank ? <span className="wt-tag">#{candidate.rank} · {candidate.score}</span> : null}</header>
                    <div className="fanout-meta">{candidate.changedFiles} changed file{candidate.changedFiles === 1 ? '' : 's'} · {candidate.executionHostId && candidate.executionHostId !== 'local' ? sshHosts.find((host) => host.id === candidate.executionHostId)?.label ?? 'SSH host' : 'local'}</div>
                    <pre className="fanout-terminal">{(terminalSnapshots[candidate.id] || (candidateActive ? 'Waiting for terminal output…' : 'No live terminal — this candidate is not running.')).slice(-4_000)}</pre>
                    {candidate.diffSummary ? <pre className="fanout-diff-summary">{candidate.diffSummary.slice(0, 2_000)}</pre> : null}
                    {candidate.error ? <div className="empty error">{candidate.error}</div> : null}
                    <div className="fanout-followup"><input disabled={!candidateActive} value={followups[candidate.id] ?? ''} onChange={(event) => setFollowups((current) => ({ ...current, [candidate.id]: event.target.value }))} placeholder="Follow-up" /><Button disabled={!candidateActive} onClick={() => { const text = followups[candidate.id] ?? ''; if (text.trim()) { void fanoutAction('fanout-control', { candidateId: candidate.id, action: 'follow-up', text }); setFollowups((current) => ({ ...current, [candidate.id]: '' })); } }}>Send</Button></div>
                    <div className="wt-actions">
                      <Button disabled={!candidateActive} onClick={() => void fanoutAction('fanout-control', { candidateId: candidate.id, action: 'approve' })}>Approve</Button>
                      <Button disabled={!candidateActive} onClick={() => void fanoutAction('fanout-control', { candidateId: candidate.id, action: 'interrupt' })}>Interrupt</Button>
                      <Button onClick={() => void fanoutAction('fanout-promote', { runId: run.id, candidateId: candidate.id, mode: 'merge' })} disabled={!candidate.changedFiles}>Merge winner</Button>
                      <Button onClick={() => void fanoutAction('fanout-promote', { runId: run.id, candidateId: candidate.id, mode: 'pr' })} disabled={!candidate.changedFiles}>Draft PR</Button>
                      <Button variant="danger" disabled={!candidate.worktreeRoot} onClick={() => void fanoutAction('fanout-cleanup', { runId: run.id, candidateId: candidate.id })}>Clean up</Button>
                    </div>
                  </article>
                );
              })}
            </div>
            {run.promotion ? <div className={run.promotion.ok ? 'sched-note' : 'empty error'}>{run.promotion.ok ? `Winner promoted by ${run.promotion.mode}.` : run.promotion.error}{run.promotion.url ? ` ${run.promotion.url}` : ''}</div> : null}
          </div>
        ))}
      </section>
      <div className="sched-add">
        <div className="sched-add-row">
          <input className="filter" placeholder="new worktree name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="filter" placeholder="base ref (HEAD)" value={ref} onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button className="sched-add-btn" onClick={submit}>Add</button>
        </div>
      </div>
      {worktrees.length === 0 ? <div className="empty">No worktrees. The main checkout plus any you add appear here.</div> : worktrees.map((w) => (
        <div key={w.path} className="wt-row">
          <div className="wt-head">
            <Icon name="branch" size={13} />
            <span className="wt-branch">{w.isDetached ? '(detached)' : w.branch || '—'}</span>
            {w.isMain ? <span className="wt-tag">main</span> : null}
            {w.isCurrent ? <span className="wt-tag cur">open</span> : null}
          </div>
          <div className="wt-path" title={w.path}>{w.path}</div>
          <div className="wt-actions">
            {!w.isCurrent ? <Button onClick={() => onOpen(w.path)}>Open</Button> : null}
            <Button onClick={() => toggleDiff(w.path)}>{openPath === w.path ? 'Hide diff' : 'Diff'}</Button>
            {!w.isMain ? <Button variant="danger" onClick={() => onRemove(w.path)}>Remove</Button> : null}
          </div>
          {openPath === w.path ? (
            <div className="wt-diff">
              {diffs[w.path] === undefined ? <div className="empty">Loading diff…</div>
                : diffs[w.path].trim() ? <DiffView diff={diffs[w.path]} />
                : <div className="empty">No uncommitted changes in this worktree.</div>}
            </div>
          ) : null}
        </div>
      ))}
      <div className="sched-note">Worktrees are sibling checkouts under <code>.worktrees/</code> — run an agent in one without touching your main checkout. “Open” switches this window to it.</div>
    </div>
  );
}
