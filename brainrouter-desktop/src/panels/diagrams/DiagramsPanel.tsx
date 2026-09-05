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
  return m[0].replace(/<svg([^>]*)>/i, `<svg$1 style="${tokens}"><style>${svgRules}</style>`);
}

export function evidenceLabel(e: string | undefined): string {
  return e === 'verified' ? 'verified against the repository' : e === 'mixed' ? 'partly verified' : 'authored, not verified';
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

  return (
    <div className="panel-body dgp">
      <div className="dgp-list" role="list" aria-label="Diagrams">
        {diagrams.length === 0 ? (
          <div className="empty">No diagrams yet. Ask for one — <code>/diagram architecture &lt;what to map&gt;</code> — or render a spec with <code>/diagram render</code>.</div>
        ) : diagrams.map((d) => (
          <button key={d.slug} role="listitem" className={`req-row dgp-row${view?.slug === d.slug ? ' selected' : ''}`} onClick={() => onOpen(d.slug)} title={d.slug}>
            <span className="dgp-row-title">{d.title ?? d.slug}</span>
            <span className="dgp-row-meta">
              <span className="dgp-kind">{d.kind ?? '?'}</span>
              {d.hasReceipt ? <span className={`dgp-checks${d.checksPassed === d.checksTotal ? '' : ' warn'}`}>{d.checksPassed}/{d.checksTotal}</span> : <span className="dgp-checks warn">spec only</span>}
              {d.evidence ? <span className={`dgp-evidence dgp-evidence-${d.evidence}`}>{d.evidence}</span> : null}
            </span>
          </button>
        ))}
      </div>
      <div className="dgp-detail">
        {!view ? (
          <div className="empty">Select a diagram to see its receipt and artifact.</div>
        ) : (
          <>
            <div className="dgp-head">
              <div>
                <div className="dgp-title">{view.title ?? view.slug} <span className="dgp-kind">{view.kind ?? ''}</span></div>
                {receipt ? (
                  <div className="dgp-receipt" title={`artifact sha256 ${receipt.artifact.sha256} · spec sha256 ${receipt.specification.sha256}`}>
                    checks {passed}/{receipt.checks.length} · {evidenceLabel(receipt.evidence)} · {receipt.artifact.bytes.toLocaleString()} B · sha256 {receipt.artifact.sha256.slice(0, 12)}… · {receipt.renderer.name}@{receipt.renderer.version}
                  </div>
                ) : <div className="dgp-receipt warn">No receipt — the specification exists but nothing was delivered. Render it: <code>/diagram render .brainrouter/diagrams/{view.slug}.json</code></div>}
                {failed.length ? <div className="dgp-receipt warn">{failed.map((c) => `${c.id}${c.detail ? ` — ${c.detail}` : ''}`).join(' · ')}</div> : null}
              </div>
              <div className="dgp-actions">
                <button className={`btn${mode === 'artifact' ? ' primary' : ''}`} onClick={() => setMode('artifact')} disabled={!view.html}>Artifact</button>
                <button className={`btn${mode === 'delta' ? ' primary' : ''}`} onClick={() => { setMode('delta'); onDelta(view.slug); }} title="Compare the working-tree specification with the one committed at HEAD">Delta vs HEAD</button>
                <button className="btn" onClick={exportSvg} disabled={!view.html} title="Download the inline SVG">Export SVG</button>
                <button className="btn" onClick={exportPng} disabled={!view.html} title="Rasterise at 2× and download">Export PNG</button>
              </div>
            </div>
            {mode === 'artifact' ? (
              view.html ? <ArtifactFrame html={view.html} title={view.title ?? view.slug} /> : <div className="empty">Not rendered yet.</div>
            ) : (
              <div className="dgp-delta">
                {!delta || delta.slug !== view.slug ? <div className="row status"><span className="spinner" /> Comparing…</div>
                  : delta.error ? <div className="empty">{delta.error}</div>
                  : delta.identical ? <div className="empty">Identical to the specification committed at {delta.base}.</div>
                  : (
                    <>
                      <div className="dgp-receipt">{delta.counts.added} added · {delta.counts.removed} removed · {delta.counts.rerouted} rerouted · {delta.counts.moved} moved · {delta.counts.changed} changed — against {delta.base}</div>
                      <ul className="dgp-facts">
                        {delta.facts.map((f) => (
                          <li key={`${f.subject}/${f.id}`}><span className={`dgp-fact dgp-fact-${f.kind}`}>{f.kind}</span> <code>{f.subject}/{f.id}</code>{f.label ? ` ${f.label}` : ''}{f.fields?.length ? <span className="dgp-fields"> — {f.fields.map((x) => `${x.field}: ${x.before ?? '∅'} → ${x.after ?? '∅'}`).join('; ')}</span> : null}</li>
                        ))}
                      </ul>
                      {delta.html ? <ArtifactFrame html={delta.html} title={`${view.slug} delta`} /> : null}
                    </>
                  )}
              </div>
            )}
            {view.sources.length ? (
              <div className="dgp-sources">
                <div className="dgp-sources-head">Sources cited</div>
                {view.sources.map((el) => (
                  <div key={el.id} className="dgp-source-el">
                    <span className="dgp-source-label">{el.label}</span>
                    {el.evidence ? <span className={`dgp-evidence dgp-evidence-${el.evidence}`}>{el.evidence}</span> : null}
                    {el.sources.map((s, i) => (
                      <span key={i} className="dgp-source">
                        <code>{s.path}{s.lines ? `:${s.lines[0]}-${s.lines[1]}` : ''}</code>
                        {onOpenFile ? <button className="btn mini" onClick={() => onOpenFile(s.path)} aria-label={`Open ${s.path}`} title="Open the file"><Icon name="file" size={11} /> open</button> : null}
                        {onShowInAtlas ? <button className="btn mini" onClick={() => onShowInAtlas(s.path)} aria-label={`Focus ${s.path} in Atlas`} title="Focus this file in the Atlas panel"><Icon name="atlas" size={11} /> Atlas</button> : null}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
