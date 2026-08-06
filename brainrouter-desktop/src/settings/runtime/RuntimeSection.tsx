/**
 * MC-DESK — Settings → Runtime. Structured UI for the Motor Cortex runtime
 * plane (`cli.runtime`), per-task budgets (`cli.budget`), the agent self-review
 * critic (`cli.critic`), and user-declared hosted CLI agents (`cli.agents.hosted`).
 *
 * Every control writes ONE dotted leaf via `setPath` (→ action:set-cli-path,
 * sibling-safe), so a change never clobbers a neighbouring knob. Clearing a
 * number reverts it to the documented default (the leaf is deleted). This
 * replaces hand-editing config.json / the `/config` slash command.
 */
import React, { useState } from 'react';
import { Row, Toggle, Select, KnobNumber, KnobText, SetGroup } from '../shared/controls.js';
import { Icon } from '../../icons.js';

type Dict = Record<string, unknown>;
type HostedAgent = { name?: string; command?: string; args?: string[]; protocol?: 'line-json' | 'stdio' };
type RuntimeRow = { id: string; backend: string; status: string; pid: number | null; worktree: string | null; createdAt: string; updatedAt: string };
type ArchiveRow = { id: string; branch: string; baseCommit: string; bytes: number; changedFiles: number; status: string; createdAt: string; note: string | null; workspaceRoot: string };
type PreviewRow = { runtimeId: string; name: string; url: string; port: number };

const BACKENDS = ['process', 'worktree', 'container', 'hosted'];
// ADR-028 C1 — described by what each engine is good at; the bare words "loop"
// and "graph" mean nothing to anyone who has not read the runtime ADR.
const ENGINES = ['loop', 'graph'];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function RuntimeSection({ knobs, setPath, runtimes = [], archives = [], previews = [], onAction, refreshSnapshot }: {
  knobs: Dict;
  setPath: (path: string, value: unknown) => void;
  runtimes?: RuntimeRow[];
  archives?: ArchiveRow[];
  previews?: PreviewRow[];
  onAction?: (id: string, name: string, args?: Record<string, unknown>) => void;
  refreshSnapshot?: () => void;
}): React.ReactElement {
  const act = (name: string, args: Record<string, unknown>): void => { onAction?.('a-rt', name, args); setTimeout(() => refreshSnapshot?.(), 150); };
  const runtime = (knobs.runtime ?? {}) as Dict;
  const critic = (knobs.critic ?? {}) as Dict;
  const budget = (knobs.budget ?? {}) as Dict;
  const container = (runtime.container ?? {}) as Dict;
  const hosted = (((knobs.agents ?? {}) as Dict).hosted ?? []) as HostedAgent[];
  const previewPorts = (runtime.previewPorts ?? {}) as Record<string, number>;

  const backend = String(runtime.backend ?? 'process');
  const engine = knobs.executionEngine === 'graph' ? 'graph' : 'loop';
  const comprehension = (knobs.comprehension ?? {}) as Dict;
  const serveOn = runtime.serve === true;
  const jitOn = runtime.jitSecrets === true;

  return (
    <>
      <div className="set-h">Runtime</div>
      <div className="set-desc" style={{ marginBottom: 8 }}>
        How agent runs execute — the backend, isolation, serving, per-task budgets and
        self-review. Everything here is <b>off / in-process by default</b>; shared with the
        CLI (<code>cli.runtime</code> / <code>cli.budget</code> / <code>cli.critic</code>).
      </div>

      <SetGroup title="Execution engine">
        <Row
          title="Engine"
          desc={<>
            How a turn is executed. <b>loop</b> runs tools in sequence and is what everything is
            built against today — interrupts, tool authorization and steer receipts all work.
            <b> graph</b> runs a checkpointed node graph that can stop and resume without repeating
            side effects, which matters for long interrupted work; it does not yet have the loop's
            interrupts or tool authorization, so selecting it currently falls back to the loop and
            says so in the session. (cli.executionEngine)
          </>}
        >
          <Select value={engine} options={ENGINES} onChange={(v) => setPath('executionEngine', v)} />
        </Row>
        {engine === 'graph' ? (
          <div className="set-desc" style={{ margin: '0 0 8px 2px' }}>
            The graph engine is incomplete — turns run on the loop until it reaches parity. This
            setting is remembered, so it takes effect as soon as it does.
          </div>
        ) : null}
      </SetGroup>

      <SetGroup title="Comprehension review">
        <Row
          title="Offer comprehension reviews"
          desc={<>
            The Understand panel asks about consequences and rejected decisions — the parts a diff
            cannot show — and you can disagree with its answers. It runs as a <b>subagent</b>: writing
            good questions needs a model reasoning over what it just built, and a heuristic would
            produce trivia. Never fires unprompted. (cli.comprehension.enabled)
          </>}
        >
          <Toggle on={comprehension.enabled !== false} onChange={(v) => setPath('comprehension.enabled', v)} />
        </Row>
        <Row title="Model" desc="Which model writes and judges the questions. Blank uses the session model. (cli.comprehension.model)">
          <KnobText value={comprehension.model} placeholder="session model" onSave={(v) => setPath('comprehension.model', v)} />
        </Row>
        <Row title="Questions" desc="How many per review. Fewer than three is not worth invoking; more than seven is homework. (cli.comprehension.questions)">
          <KnobNumber value={comprehension.questions} placeholder="5" onSave={(v) => setPath('comprehension.questions', v)} />
        </Row>
      </SetGroup>

      <SetGroup title="Backend">
        <Row title="Backend" desc={<>Where agent conversations run. <b>process</b> = in-process (today's behavior); <b>worktree</b> = git-isolated; <b>container</b> = Docker (needs an image); <b>hosted</b> = a declared external CLI. (cli.runtime.backend)</>}>
          <Select value={backend} options={BACKENDS} onChange={(v) => setPath('runtime.backend', v)} />
        </Row>
        <Row title="Max live runtimes" desc="Cap on concurrently live runtime instances before least-recently-used parking. 0 or blank = no cap. (cli.runtime.maxLive)">
          <KnobNumber value={runtime.maxLive} placeholder="0 = uncapped" onSave={(v) => setPath('runtime.maxLive', v)} />
        </Row>
      </SetGroup>

      {backend === 'container' ? (
        <SetGroup title="Container backend">
          <Row title="Image" desc="Docker image the container backend runs. No default and no automatic pulls — the backend refuses to start until this is set. (cli.runtime.containerImage)">
            <KnobText value={runtime.containerImage} placeholder="e.g. ghcr.io/org/agent:latest" onSave={(v) => setPath('runtime.containerImage', v)} />
          </Row>
          <Row title="CPU limit" desc="docker run --cpus (fractional allowed). Blank = no limit. (cli.runtime.container.cpus)">
            <KnobNumber value={container.cpus} placeholder="no limit" onSave={(v) => setPath('runtime.container.cpus', v)} />
          </Row>
          <Row title="Memory limit" desc="docker run --memory, e.g. 512m or 2g. Blank = no limit. (cli.runtime.container.memory)">
            <KnobText value={container.memory} placeholder="e.g. 2g" onSave={(v) => setPath('runtime.container.memory', v)} />
          </Row>
        </SetGroup>
      ) : null}

      <SetGroup title="Workspace archives" collapsible defaultOpen={false}>
        <Row title="Archive on dispose" desc="When a throwaway worktree runtime is disposed, save a durable archive (git-delta patch + changed-file tarball + manifest) so uncommitted work is recoverable. (cli.runtime.archiveOnDispose)">
          <Toggle on={runtime.archiveOnDispose !== false} onChange={(v) => setPath('runtime.archiveOnDispose', v)} />
        </Row>
        <Row title="Keep archives" desc="How many archives to retain, newest-first. 0 = no count-based pruning. Default 20. (cli.runtime.archiveKeep)">
          <KnobNumber value={runtime.archiveKeep} placeholder="20" onSave={(v) => setPath('runtime.archiveKeep', v)} />
        </Row>
        <Row title="Max archive size (MB)" desc="Cap on the changed-file tarball; oversize payloads keep just the git-delta patch. Default 64. (cli.runtime.archiveMaxMB)">
          <KnobNumber value={runtime.archiveMaxMB} placeholder="64" onSave={(v) => setPath('runtime.archiveMaxMB', v)} />
        </Row>
      </SetGroup>

      <SetGroup title="JIT secrets" collapsible defaultOpen={false}>
        <Row title="Lease secrets to children" desc="Replace secret-shaped env vars in a child runtime with single-use, short-TTL lease tokens redeemed at point-of-use. Off = children get raw env values (today's behavior). (cli.runtime.jitSecrets)">
          <Toggle on={jitOn} onChange={(v) => setPath('runtime.jitSecrets', v)} />
        </Row>
        {jitOn ? (
          <Row title="Lease lifetime (ms)" desc="How long a JIT secret token stays redeemable. Default 60000, clamped 1000–3600000. (cli.runtime.jitSecretTtlMs)">
            <KnobNumber value={runtime.jitSecretTtlMs} placeholder="60000" onSave={(v) => setPath('runtime.jitSecretTtlMs', v)} />
          </Row>
        ) : null}
      </SetGroup>

      <SetGroup title="Serve &amp; remote" collapsible defaultOpen={false}>
        <Row title="Serve local runtime contract" desc="Expose the versioned runtime HTTP contract on loopback so desktop/CLI can act as runner clients. Off by default. (cli.runtime.serve)">
          <Toggle on={serveOn} onChange={(v) => setPath('runtime.serve', v)} />
        </Row>
        {serveOn ? (
          <>
            <Row title="Serve host" desc="Bind interface for the runtime contract. Defaults to loopback. (cli.runtime.serveHost)">
              <KnobText value={runtime.serveHost} placeholder="127.0.0.1" onSave={(v) => setPath('runtime.serveHost', v)} />
            </Row>
            <Row title="Serve port" desc="Port for the runtime contract. Default 8791. (cli.runtime.servePort)">
              <KnobNumber value={runtime.servePort} placeholder="8791" onSave={(v) => setPath('runtime.servePort', v)} />
            </Row>
          </>
        ) : null}
        <Row title="Remote runtime URL" desc="Point runs at a remote runtime runner instead of in-process. Blank = in-process. (cli.runtime.remoteUrl)">
          <KnobText value={runtime.remoteUrl} placeholder="https://runner.example.com" onSave={(v) => setPath('runtime.remoteUrl', v)} />
        </Row>
      </SetGroup>

      <PreviewPortsEditor ports={previewPorts} onChange={(next) => setPath('runtime.previewPorts', Object.keys(next).length ? next : null)} />

      <SetGroup title="Active runtimes">
        <div className="set-desc" style={{ marginBottom: 8 }}>Runtime instances recorded on disk (live + parked). Dispose removes a stale record.</div>
        {runtimes.length === 0 ? <div className="empty">No runtime instances recorded.</div> : runtimes.map((r) => (
          <Row key={r.id} title={<>{r.id} <span className={`badge ${r.status === 'ready' || r.status === 'running' ? 'native' : 'cli'}`} style={{ marginLeft: 6 }}>{r.status}</span></>}
            desc={<>{r.backend}{r.pid ? ` · pid ${r.pid}` : ' · not live'}{r.worktree ? <> · <code>{r.worktree}</code></> : null}</>}>
            <button className="btn danger" onClick={() => act('action:runtime-remove-record', { id: r.id })}>Dispose</button>
          </Row>
        ))}
      </SetGroup>

      {previews.length ? (
        <SetGroup title="Live preview servers">
          {previews.map((p) => (
            <Row key={`${p.runtimeId}:${p.name}`} title={p.name} desc={<>{p.runtimeId} · <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a></>} />
          ))}
        </SetGroup>
      ) : null}

      <SetGroup title="Archived runs" collapsible defaultOpen={false}
        right={archives.length ? <button className="btn btn--chip" onClick={() => act('action:runtime-prune-archives', {})}>Prune old</button> : null}>
        <div className="set-desc" style={{ marginBottom: 8 }}>Disposed worktree runtimes, newest first. Resume recreates the worktree and re-applies the saved changes.</div>
        {archives.length === 0 ? <div className="empty">No archives.</div> : archives.map((a) => (
          <Row key={a.id} title={<>{a.branch} <span className={`badge ${a.status === 'ok' ? 'native' : 'cli'}`} style={{ marginLeft: 6 }}>{a.status}</span></>}
            desc={<>{a.baseCommit} · {a.changedFiles} files · {fmtBytes(a.bytes)} · {new Date(a.createdAt).toLocaleString()}{a.note ? <> · <span style={{ color: 'rgb(214,156,60)' }}>{a.note}</span></> : null}</>}>
            <button className="btn" onClick={() => act('action:runtime-resume-archive', { id: a.id })}>Resume</button>
          </Row>
        ))}
      </SetGroup>

      <SetGroup title="Per-task budget">
        <div className="set-desc" style={{ marginBottom: 8 }}>Hard caps on a single agent task. When a cap is hit the task stops with a budget error. 0 or blank = uncapped. (cli.budget)</div>
        <Row title="Max USD per task" desc="Stop a task once its estimated spend exceeds this. (cli.budget.maxPerTaskUSD)">
          <KnobNumber value={budget.maxPerTaskUSD} placeholder="0 = uncapped" onSave={(v) => setPath('budget.maxPerTaskUSD', v)} />
        </Row>
        <Row title="Max tokens per task" desc="Stop a task once total tokens exceed this. (cli.budget.maxPerTaskTokens)">
          <KnobNumber value={budget.maxPerTaskTokens} placeholder="0 = uncapped" onSave={(v) => setPath('budget.maxPerTaskTokens', v)} />
        </Row>
      </SetGroup>

      <SetGroup title="Critic (agent self-review)" collapsible defaultOpen={false}>
        <div className="set-desc" style={{ marginBottom: 8 }}>Score a build against a threshold and refine below it. Off by default. (cli.critic)</div>
        <Row title="Enable critic" desc="Run a scoring pass after a build and refine when it's below threshold. (cli.critic.enabled)">
          <Toggle on={critic.enabled === true} onChange={(v) => setPath('critic.enabled', v)} />
        </Row>
        {critic.enabled === true ? (
          <>
            <Row title="Acceptance threshold" desc="Score in 0–1 the build must reach. Default 0.7. (cli.critic.threshold)">
              <KnobNumber value={critic.threshold} placeholder="0.7" onSave={(v) => setPath('critic.threshold', v)} />
            </Row>
            <Row title="Max refinement rounds" desc="How many times to refine when below threshold. Default 2, clamped 0–8. (cli.critic.maxRefinementIterations)">
              <KnobNumber value={critic.maxRefinementIterations} placeholder="2" onSave={(v) => setPath('critic.maxRefinementIterations', v)} />
            </Row>
            <Row title="Critic model" desc="Explicit model for the scoring pass. Blank = the reviewer role model, falling back to the session model. (cli.critic.model)">
              <KnobText value={critic.model} placeholder="(role default)" onSave={(v) => setPath('critic.model', v)} />
            </Row>
          </>
        ) : null}
      </SetGroup>

      <HostedAgentsEditor hosted={hosted} onChange={(next) => setPath('agents.hosted', next.length ? next : null)} />
    </>
  );
}

/** MC-A3/MC-C5 — durable named port defaults; live endpoints belong to Servers. */
function PreviewPortsEditor({ ports, onChange }: { ports: Record<string, number>; onChange: (next: Record<string, number>) => void }): React.ReactElement {
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const entries = Object.entries(ports).sort((a, b) => a[0].localeCompare(b[0]));
  const add = (): void => {
    const n = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    const p = Number(port);
    if (!n || !Number.isInteger(p) || p < 1 || p > 65535) return;
    onChange({ ...ports, [n]: p });
    setName(''); setPort('');
  };
  const remove = (key: string): void => { const next = { ...ports }; delete next[key]; onChange(next); };
  return (
    <SetGroup title="Runtime preview port reservations" collapsible defaultOpen={false}>
      <div className="set-desc" style={{ marginBottom: 8 }}>
        Durable loopback port defaults for runtime previews. Live registered endpoints appear in the Servers view. (cli.runtime.previewPorts)
      </div>
      {entries.length === 0 ? <div className="empty">No runtime preview ports reserved.</div> : entries.map(([key, val]) => (
        <div key={key} className="rule-row">
          <span className="rule-kind allow">{key}</span>
          <span className="rule-text">127.0.0.1:{val}</span>
          <button className="tab-close-btn rule-x" aria-label={`Remove preview port ${key}`} title="Remove" onClick={() => remove(key)}><Icon name="close" size={11} /></button>
        </div>
      ))}
      <div className="rule-add">
        <input className="ctl" placeholder="name, e.g. web" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <input className="ctl" placeholder="port" value={port} style={{ maxWidth: 90 }} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="btn" disabled={!name.trim() || !port} onClick={add}>Reserve</button>
      </div>
    </SetGroup>
  );
}

/** MC-D2 — user-declared external CLI agents usable as a `hosted` backend. */
function HostedAgentsEditor({ hosted, onChange }: { hosted: HostedAgent[]; onChange: (next: HostedAgent[]) => void }): React.ReactElement {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [protocol, setProtocol] = useState<'line-json' | 'stdio'>('line-json');
  const add = (): void => {
    const n = name.trim(); const c = command.trim();
    if (!n || !c) return;
    const parsedArgs = args.trim() ? args.trim().split(/\s+/) : [];
    onChange([...hosted.filter((h) => h.name !== n), { name: n, command: c, args: parsedArgs, protocol }]);
    setName(''); setCommand(''); setArgs(''); setProtocol('line-json');
  };
  const remove = (n?: string): void => onChange(hosted.filter((h) => h.name !== n));
  return (
    <SetGroup title="Hosted CLI agents" collapsible defaultOpen={false}>
      <div className="set-desc" style={{ marginBottom: 8 }}>External agent CLIs you can run inside a runtime (pick the <b>hosted</b> backend above). No binaries are bundled — you declare the command. (cli.agents.hosted)</div>
      {hosted.length === 0 ? <div className="empty">No hosted agents declared.</div> : hosted.map((h) => (
        <Row key={h.name} title={h.name ?? '(unnamed)'} desc={<><code>{[h.command, ...(h.args ?? [])].filter(Boolean).join(' ')}</code> · {h.protocol ?? 'line-json'}</>}>
          <button className="tab-close-btn rule-x" aria-label={`Remove hosted agent ${h.name}`} title="Remove" onClick={() => remove(h.name)}><Icon name="close" size={11} /></button>
        </Row>
      ))}
      <div className="rule-add" style={{ flexWrap: 'wrap', gap: 6 }}>
        <input className="ctl" placeholder="name" value={name} style={{ maxWidth: 120 }} onChange={(e) => setName(e.target.value)} />
        <input className="ctl" placeholder="command, e.g. claude" value={command} style={{ maxWidth: 160 }} onChange={(e) => setCommand(e.target.value)} />
        <input className="ctl" placeholder="args (space-separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
        <Select value={protocol} options={['line-json', 'stdio']} onChange={(v) => setProtocol(v as 'line-json' | 'stdio')} />
        <button className="btn" disabled={!name.trim() || !command.trim()} onClick={add}>Add agent</button>
      </div>
    </SetGroup>
  );
}
