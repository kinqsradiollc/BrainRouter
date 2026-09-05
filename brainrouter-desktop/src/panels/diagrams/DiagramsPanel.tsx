/**
 * ADR-056 D-A5 — the Diagrams panel: every diagram the workspace keeps under
 * `.brainrouter/diagrams/`, its receipt (checks, hashes, evidence), the
 * delivered artifact in a sealed frame, the sources each element cites (open
 * the file, or focus it in Atlas), exports of the artifact as SVG or PNG, and
 * the Before · Delta · After comparison against the committed specification.
 *
 * Props-driven like the Atlas panel: the host queries (`diagram-list`,
 * `diagram-read`, `diagram-delta`) land in App state and arrive here as data;
 * the panel never touches the bridge itself, so it renders populated from the
 * devBridge fixtures in a plain browser. The artifact frame follows the
 * Artifacts panel's rule: an electron `<webview>` with a forced no-network CSP
 * when available, else a sandboxed `<iframe>`; either way the page cannot reach
 * the app or the network — and it needs neither, being self-contained.
 *
 * Layout: a compact library above (one row per diagram, meta cluster on the
 * right), the opened diagram below — title, a receipt strip of labelled stats,
 * a segmented Artifact | Delta switch with the exports beside it, and the
 * frame taking whatever height is left. Sources close the column.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../icons.js';
import { download } from '../../lib/format.js';
import type { DiagramDeltaResult, DiagramListRow, DiagramReadResult } from '../../lib/diagrams/types.js';

export interface DiagramsPanelProps {
  diagrams: DiagramListRow[];
  view: DiagramReadResult | null;
  delta: DiagramDeltaResult | null;
  onLoad: () => void;
  onOpen: (slug: string) => void;
  onDelta: (slug: string) => void;
  onOpenFile?: (path: string) => void;
  onShowInAtlas?: (path: string) => void;
}

const FRAME_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

/** The artifact with the frame's own network-blocking CSP injected first — belt and braces over the artifact's own. */
export function sealDiagramHtml(html: string): string {
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + FRAME_CSP) : FRAME_CSP + html;
}

/** The inline SVG of a delivered artifact, or null. Exported for tests and the SVG/PNG export. */
export function extractDiagramSvg(html: string): string | null {
  const m = html.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return null;
  // Inline the token block so the SVG stands alone: take every --dg-* declaration and put it on the svg element.
  const tokens = [...html.matchAll(/--dg-[a-z-]+:[^;}]+/gi)].map((t) => t[0]).join(';');
  const styles = html.match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? '';
  const svgRules = styles.split('}').map((r) => r.trim()).filter((r) => /^\.dg-|^\[data-theme|^:root/.test(r)).map((r) => `${r}}`).join('');
  // Merge into an existing style attribute rather than adding a second one (browsers keep only the first).
  return m[0].replace(/<svg([^>]*)>/i, (_all, attrs: string) => {
    const merged = /\sstyle="/i.test(attrs)
      ? attrs.replace(/\sstyle="([^"]*)"/i, (_s, existing: string) => ` style="${existing.replace(/;?\s*$/, ';')}${tokens}"`)
      : `${attrs} style="${tokens}"`;
    return `<svg${merged}><style>${svgRules}</style>`;
  });
}

export function evidenceLabel(e: string | undefined): string {
  return e === 'verified' ? 'verified against the repository' : e === 'mixed' ? 'partly verified' : 'authored, not verified';
}

const KIND_LABEL: Record<string, string> = { architecture: 'Architecture', workflow: 'Workflow', sequence: 'Sequence', dataflow: 'Data flow', lifecycle: 'Lifecycle' };

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

function ArtifactFrame({ html, title }: { html: string; title: string }): React.ReactElement {
  const hasWebview = typeof window !== 'undefined' && 'customElements' in window && !!window.customElements.get?.('webview');
  const sealed = useMemo(() => sealDiagramHtml(html), [html]);
  if (hasWebview) {
    return React.createElement('webview', {
      className: 'dgp-frame',
      src: `data:text/html;charset=utf-8,${encodeURIComponent(sealed)}`,
      partition: 'persist:proto-preview',
      allowpopups: 'false',
      title,
    });
  }
  return <iframe className="dgp-frame" title={title} sandbox="allow-scripts" srcDoc={sealed} />;
}

function Pill({ tone, children, title }: { tone?: 'ok' | 'warn' | 'muted'; children: React.ReactNode; title?: string }): React.ReactElement {
  return <span className={`dgp-pill${tone ? ` dgp-pill-${tone}` : ''}`} title={title}>{children}</span>;
}

export function DiagramsPanel({ diagrams, view, delta, onLoad, onOpen, onDelta, onOpenFile, onShowInAtlas }: DiagramsPanelProps): React.ReactElement {
  const [mode, setMode] = useState<'artifact' | 'delta'>('artifact');
  useEffect(() => { onLoad(); }, [onLoad]);
  useEffect(() => { setMode('artifact'); }, [view?.slug]);

  const exportSvg = (): void => {
    if (!view?.html) return;
    const svg = extractDiagramSvg(view.html);
    if (svg) download(`${view.slug}.svg`, svg);
  };
  const exportPng = (): void => {
    if (!view?.html) return;
    const svg = extractDiagramSvg(view.html);
    if (!svg) return;
    const size = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    const w = Number(size?.[1] ?? 1200), h = Number(size?.[2] ?? 800);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = `${view.slug}.png`; a.click(); URL.revokeObjectURL(a.href);
      }, 'image/png');
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };

  const receipt = view?.receipt ?? null;
  const passed = receipt ? receipt.checks.filter((c) => c.ok).length : 0;
  const failed = receipt ? receipt.checks.filter((c) => !c.ok) : [];
  const deltaReady = !!delta && !!view && delta.slug === view.slug;

  return (
    <div className="panel-body dgp">
      <div className="dgp-library" role="list" aria-label="Diagrams">
        <div className="dgp-library-head"><span>Diagrams</span><span className="dgp-library-count">{diagrams.length}</span></div>
        {diagrams.length === 0 ? (
          <div className="empty dgp-empty">
            <div>No diagrams yet.</div>
            <div className="dgp-empty-hint">Ask for one — <code>/diagram architecture &lt;what to map&gt;</code> — or render a spec with <code>/diagram render</code>.</div>
          </div>
        ) : diagrams.map((d) => (
          <button key={d.slug} role="listitem" className={`req-row dgp-row${view?.slug === d.slug ? ' active' : ''}`} onClick={() => onOpen(d.slug)} title={d.slug} aria-current={view?.slug === d.slug ? 'true' : undefined}>
            <span className="dgp-row-main">
              <span className="dgp-row-title">{d.title ?? d.slug}</span>
              <span className="dgp-row-slug">{d.slug}</span>
            </span>
            <span className="dgp-row-meta">
              <Pill tone="muted">{KIND_LABEL[d.kind ?? ''] ?? '—'}</Pill>
              {d.hasReceipt
                ? <Pill tone={d.checksPassed === d.checksTotal ? 'ok' : 'warn'} title="Artifact checks passed">{d.checksPassed === d.checksTotal ? '✓' : '⚠'} {d.checksPassed}/{d.checksTotal}</Pill>
                : <Pill tone="warn" title="Specification exists; nothing delivered yet">spec only</Pill>}
              {d.evidence ? <Pill tone={d.evidence === 'verified' ? 'ok' : 'muted'} title={evidenceLabel(d.evidence)}>{d.evidence}</Pill> : null}
            </span>
          </button>
        ))}
      </div>

      <div className="dgp-detail">
        {!view ? (
          <div className="empty dgp-empty">Select a diagram to see its receipt and artifact.</div>
        ) : (
          <>
            <header className="dgp-head">
              <div className="dgp-head-titles">
                <h3 className="dgp-title">{view.title ?? view.slug}</h3>
                <div className="dgp-subtitle"><span>{KIND_LABEL[view.kind ?? ''] ?? 'Diagram'}</span><span className="dgp-dot">·</span><code>.brainrouter/diagrams/{view.slug}.html</code></div>
              </div>
              {receipt ? (
                <dl className="dgp-stats" aria-label="Receipt">
                  <div className={`dgp-stat${failed.length ? ' warn' : ''}`}><dt>Checks</dt><dd>{passed}/{receipt.checks.length}</dd></div>
                  <div className="dgp-stat"><dt>Evidence</dt><dd title={evidenceLabel(receipt.evidence)}>{receipt.evidence}</dd></div>
                  <div className="dgp-stat"><dt>Artifact</dt><dd>{formatBytes(receipt.artifact.bytes)}</dd></div>
                  <div className="dgp-stat"><dt>SHA-256</dt><dd title={`artifact ${receipt.artifact.sha256} · spec ${receipt.specification.sha256}`}><code>{receipt.artifact.sha256.slice(0, 10)}</code></dd></div>
                  <div className="dgp-stat"><dt>Renderer</dt><dd>{receipt.renderer.version}</dd></div>
                </dl>
              ) : (
                <div className="dgp-notice warn">No receipt — the specification exists but nothing was delivered. Render it: <code>/diagram render .brainrouter/diagrams/{view.slug}.json</code></div>
              )}
              {failed.length ? <div className="dgp-notice warn">{failed.map((c) => `${c.id}${c.detail ? ` — ${c.detail}` : ''}`).join(' · ')}</div> : null}
              <div className="dgp-toolbar">
                <div className="dgp-segment" role="tablist" aria-label="View">
                  <button role="tab" aria-selected={mode === 'artifact'} className={`btn${mode === 'artifact' ? ' primary' : ''}`} onClick={() => setMode('artifact')} disabled={!view.html}>Artifact</button>
                  <button role="tab" aria-selected={mode === 'delta'} className={`btn${mode === 'delta' ? ' primary' : ''}`} onClick={() => { setMode('delta'); onDelta(view.slug); }} title="Compare the working-tree specification with the one committed at HEAD">Delta vs HEAD</button>
                </div>
                <div className="dgp-exports">
                  <button className="btn" onClick={exportSvg} disabled={!view.html} title="Download the inline SVG with its tokens"><Icon name="file" size={11} /> SVG</button>
                  <button className="btn" onClick={exportPng} disabled={!view.html} title="Rasterise at 2× and download"><Icon name="file" size={11} /> PNG</button>
                </div>
              </div>
            </header>

            {mode === 'artifact' ? (
              view.html ? <ArtifactFrame html={view.html} title={view.title ?? view.slug} /> : <div className="empty dgp-empty">Not rendered yet.</div>
            ) : (
              <div className="dgp-delta">
                {!deltaReady ? <div className="row status"><span className="spinner" /> Comparing…</div>
                  : delta!.error ? <div className="empty dgp-empty">{delta!.error}</div>
                  : delta!.identical ? <div className="empty dgp-empty">Identical to the specification committed at {delta!.base}.</div>
                  : (
                    <>
                      <div className="dgp-delta-summary" aria-label="Delta summary">
                        {(['added', 'removed', 'rerouted', 'moved', 'changed'] as const).map((k) => (
                          <span key={k} className={`dgp-count${delta!.counts[k] ? '' : ' zero'}`}><strong>{delta!.counts[k]}</strong> {k}</span>
                        ))}
                        <span className="dgp-count-base">against <code>{delta!.base}</code></span>
                      </div>
                      <ul className="dgp-facts">
                        {delta!.facts.map((f) => (
                          <li key={`${f.subject}/${f.id}`} className="dgp-fact-row">
                            <span className={`dgp-pill dgp-fact-${f.kind}`}>{f.kind}</span>
                            <span className="dgp-fact-body">
                              <code>{f.subject}/{f.id}</code>{f.label ? <span className="dgp-fact-label"> {f.label}</span> : null}
                              {f.fields?.length ? <span className="dgp-fact-fields">{f.fields.map((x) => `${x.field}: ${x.before ?? '∅'} → ${x.after ?? '∅'}`).join(' · ')}</span> : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {delta!.html ? <ArtifactFrame html={delta!.html} title={`${view.slug} delta`} /> : null}
                    </>
                  )}
              </div>
            )}

            {view.sources.length ? (
              <section className="dgp-sources" aria-label="Sources cited">
                <div className="dgp-section-head">Sources cited <span className="dgp-library-count">{view.sources.reduce((n, el) => n + el.sources.length, 0)}</span></div>
                {view.sources.map((el) => (
                  <div key={el.id} className="dgp-source-el">
                    <div className="dgp-source-el-head">
                      <span className="dgp-source-label">{el.label}</span>
                      {el.evidence ? <Pill tone={el.evidence === 'verified' ? 'ok' : el.evidence === 'unverified' ? 'warn' : 'muted'} title={evidenceLabel(el.evidence)}>{el.evidence}</Pill> : null}
                    </div>
                    {el.sources.map((s, i) => (
                      <div key={i} className="dgp-source">
                        <code className="dgp-source-path">{s.path}{s.lines ? <span className="dgp-source-lines">:{s.lines[0]}–{s.lines[1]}</span> : null}</code>
                        <span className="dgp-source-actions">
                          {onOpenFile ? <button className="btn ghost" onClick={() => onOpenFile(s.path)} aria-label={`Open ${s.path}`} title="Open the file"><Icon name="file" size={11} /> Open</button> : null}
                          {onShowInAtlas ? <button className="btn ghost" onClick={() => onShowInAtlas(s.path)} aria-label={`Focus ${s.path} in Atlas`} title="Focus this file in the Atlas panel"><Icon name="atlas" size={11} /> Atlas</button> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
