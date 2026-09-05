/**
 * Self-contained HTML shell for a rendered diagram (ADR-056 D-A2).
 *
 * One file, no network: the theme is CSS variables (dark default, light via
 * `data-theme="light"`, `auto` follows `prefers-color-scheme`), the viewer is a
 * few hundred lines of inline script — pan/zoom, search, focus with
 * relationship tracing, curated views, a details panel — and every element
 * fact the panel shows comes from an inline JSON block copied from the
 * validated document. Viewer state (theme, zoom, focus) never enters the SVG,
 * so the canonical export is the same file regardless of how it was read.
 * Motion is limited to short transitions and honours `prefers-reduced-motion`.
 */
import type { Diagram } from '@kinqs/brainrouter-types';
import type { Scene } from './layout.js';
import { escapeXml } from './svg.js';

export interface HtmlOptions {
  theme: 'auto' | 'dark' | 'light';
  /** Renderer version stamped into the document for provenance. */
  rendererVersion: string;
}

const CSS = `
:root{--dg-bg:#0b1020;--dg-panel:#111a2e;--dg-ink:#eef2ff;--dg-muted:#94a3b8;--dg-dim:#475569;--dg-border:#243049;--dg-mask:#0b1020;
--dg-frontend:#22d3ee;--dg-backend:#34d399;--dg-database:#a78bfa;--dg-cloud:#fbbf24;--dg-security:#fb7185;--dg-messagebus:#fb923c;--dg-external:#94a3b8;
--dg-step:#7dd3fc;--dg-state:#7dd3fc;--dg-initial:#34d399;--dg-terminal:#a78bfa;--dg-failure:#fb7185;--dg-waiting:#fbbf24;
--dg-edge:#64748b;--dg-edge-primary:#22d3ee;--dg-focus:#22d3ee;--dg-band:#0f172a;--dg-group:#0f172a;--dg-radius:8px;--dg-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--dg-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
[data-theme="light"]{--dg-bg:#f8fafc;--dg-panel:#ffffff;--dg-ink:#0f172a;--dg-muted:#475569;--dg-dim:#94a3b8;--dg-border:#cbd5e1;--dg-mask:#f8fafc;--dg-edge:#64748b;--dg-band:#f1f5f9;--dg-group:#f1f5f9;
--dg-frontend:#0891b2;--dg-backend:#059669;--dg-database:#7c3aed;--dg-cloud:#b45309;--dg-security:#e11d48;--dg-messagebus:#c2410c;--dg-external:#475569;--dg-step:#0369a1;--dg-state:#0369a1;--dg-initial:#059669;--dg-terminal:#7c3aed;--dg-failure:#e11d48;--dg-waiting:#b45309;--dg-edge-primary:#0891b2;--dg-focus:#0891b2}
@media (prefers-color-scheme: light){[data-theme="auto"]{--dg-bg:#f8fafc;--dg-panel:#ffffff;--dg-ink:#0f172a;--dg-muted:#475569;--dg-dim:#94a3b8;--dg-border:#cbd5e1;--dg-mask:#f8fafc;--dg-edge:#64748b;--dg-band:#f1f5f9;--dg-group:#f1f5f9;
--dg-frontend:#0891b2;--dg-backend:#059669;--dg-database:#7c3aed;--dg-cloud:#b45309;--dg-security:#e11d48;--dg-messagebus:#c2410c;--dg-external:#475569;--dg-step:#0369a1;--dg-state:#0369a1;--dg-initial:#059669;--dg-terminal:#7c3aed;--dg-failure:#e11d48;--dg-waiting:#b45309;--dg-edge-primary:#0891b2;--dg-focus:#0891b2}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--dg-bg);color:var(--dg-ink);font:13px/1.45 var(--dg-font)}
.dg-app{display:grid;grid-template-columns:1fr 300px;grid-template-rows:auto 1fr;height:100vh}
.dg-bar{grid-column:1/3;display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--dg-border);background:var(--dg-panel)}
.dg-title{font-weight:700;font-size:15px;margin:0}.dg-subtitle{color:var(--dg-muted);margin:0 0 0 8px}
.dg-bar .dg-spacer{flex:1}.dg-bar input{background:var(--dg-bg);color:var(--dg-ink);border:1px solid var(--dg-border);border-radius:var(--dg-radius);padding:6px 10px;min-width:220px;font:inherit}
.dg-btn{background:var(--dg-bg);color:var(--dg-ink);border:1px solid var(--dg-border);border-radius:var(--dg-radius);padding:6px 10px;cursor:pointer;font:inherit}.dg-btn:hover{border-color:var(--dg-muted)}.dg-btn[aria-pressed="true"]{border-color:var(--dg-focus);color:var(--dg-focus)}
.dg-canvas{position:relative;overflow:hidden;cursor:grab}.dg-canvas.dragging{cursor:grabbing}.dg-stage{transform-origin:0 0;will-change:transform}
.dg-side{border-left:1px solid var(--dg-border);background:var(--dg-panel);padding:14px 16px;overflow:auto}
.dg-side h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dg-muted);margin:14px 0 6px}.dg-side h2:first-child{margin-top:0}
.dg-legend{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px 12px}.dg-legend li{display:flex;align-items:center;gap:6px;color:var(--dg-muted)}.dg-swatch{width:10px;height:10px;border-radius:3px;display:inline-block}
.dg-views{display:flex;flex-wrap:wrap;gap:6px}.dg-detail{border:1px solid var(--dg-border);border-radius:var(--dg-radius);padding:10px;min-height:60px}.dg-detail .dg-k{color:var(--dg-muted)}.dg-detail code{font-family:var(--dg-mono);font-size:12px;word-break:break-all}
.dg-detail ul{margin:6px 0 0;padding-left:16px}.dg-empty{color:var(--dg-dim)}
svg.dg-svg{display:block;font-family:var(--dg-font)}
.dg-shape{fill:var(--dg-panel);stroke:var(--dg-edge);stroke-width:1.5}.dg-shape-tab{fill:var(--dg-step)}
.dg-node .dg-label{fill:var(--dg-ink);font-size:13px;font-weight:600}
.dg-type-frontend .dg-shape{stroke:var(--dg-frontend)}.dg-type-backend .dg-shape{stroke:var(--dg-backend)}.dg-type-database .dg-shape{stroke:var(--dg-database)}.dg-type-cloud .dg-shape{stroke:var(--dg-cloud)}.dg-type-security .dg-shape{stroke:var(--dg-security)}.dg-type-messagebus .dg-shape{stroke:var(--dg-messagebus)}.dg-type-external .dg-shape{stroke:var(--dg-external);stroke-dasharray:4 3}
.dg-type-step .dg-shape{stroke:var(--dg-step)}.dg-type-state .dg-shape{stroke:var(--dg-state)}.dg-type-initial .dg-shape{stroke:var(--dg-initial);stroke-width:2.5}.dg-type-terminal .dg-shape{stroke:var(--dg-terminal);stroke-width:2.5}.dg-type-failure .dg-shape{stroke:var(--dg-failure)}.dg-type-waiting .dg-shape{stroke:var(--dg-waiting)}
.dg-variant-emphasis .dg-shape{stroke-width:3}.dg-variant-dashed .dg-shape{stroke-dasharray:5 4}.dg-variant-security .dg-shape{stroke:var(--dg-security)}
.dg-node.dg-primary .dg-shape{filter:drop-shadow(0 0 0 transparent);stroke-width:2.5}
.dg-lifeline{stroke:var(--dg-dim);stroke-dasharray:4 4;stroke-width:1}.dg-activation{fill:var(--dg-panel);stroke:var(--dg-edge);stroke-width:1.2}
.dg-path{fill:none;stroke:var(--dg-edge);stroke-width:1.5}.dg-stroke-dashed .dg-path{stroke-dasharray:6 4}.dg-stroke-data .dg-path{stroke-width:2.5;opacity:.85}.dg-edge.dg-primary .dg-path{stroke:var(--dg-edge-primary);stroke-width:2.5}
.dg-arrowhead{fill:var(--dg-edge)}.dg-arrowhead-open{fill:none;stroke:var(--dg-edge);stroke-width:1.5}.dg-edge.dg-primary .dg-arrowhead{fill:var(--dg-edge-primary)}
.dg-edge-mask{fill:var(--dg-mask)}.dg-edge-label{fill:var(--dg-muted);font-size:11px}
.dg-band-rect{fill:var(--dg-band);stroke:var(--dg-border)}.dg-band-label{fill:var(--dg-muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:600}
.dg-group-rect{fill:var(--dg-group);stroke:var(--dg-border);stroke-dasharray:6 4}.dg-group-label{fill:var(--dg-muted);font-size:11px;font-weight:600;letter-spacing:.04em}
.dg-beacon{fill:var(--dg-backend)}
.dg-node:focus{outline:none}.dg-node:focus .dg-shape,.dg-node.is-focus .dg-shape{stroke:var(--dg-focus);stroke-width:3}
.has-focus .dg-node:not(.is-focus):not(.is-near),.has-focus .dg-edge:not(.is-near){opacity:.18}.dg-edge.is-near .dg-path{stroke:var(--dg-focus)}.dg-edge.is-near .dg-arrowhead{fill:var(--dg-focus)}
.has-search .dg-node:not(.is-hit){opacity:.18}
.dg-node,.dg-edge{transition:opacity 160ms ease}@media (prefers-reduced-motion:reduce){.dg-node,.dg-edge{transition:none}}
@media (max-width:820px){.dg-app{grid-template-columns:1fr}.dg-side{display:none}}
`;

const JS = `
(function(){
var data=JSON.parse(document.getElementById('dg-data').textContent);
var root=document.documentElement,canvas=document.querySelector('.dg-canvas'),stage=document.querySelector('.dg-stage'),svg=stage.querySelector('svg');
var nodes=Array.prototype.slice.call(svg.querySelectorAll('.dg-node')),edges=Array.prototype.slice.call(svg.querySelectorAll('.dg-edge'));
var byId={};data.nodes.forEach(function(n){byId[n.id]=n});
var scale=1,tx=0,ty=0;function apply(){stage.style.transform='translate('+tx+'px,'+ty+'px) scale('+scale+')'}
function fit(){var vw=svg.viewBox.baseVal.width,vh=svg.viewBox.baseVal.height,cw=canvas.clientWidth,ch=canvas.clientHeight;scale=Math.min(1.6,Math.max(.2,Math.min((cw-32)/vw,(ch-32)/vh)));tx=(cw-vw*scale)/2;ty=(ch-vh*scale)/2;apply()}
canvas.addEventListener('wheel',function(e){e.preventDefault();var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,k=e.deltaY<0?1.1:1/1.1,ns=Math.min(4,Math.max(.15,scale*k));tx=mx-(mx-tx)*(ns/scale);ty=my-(my-ty)*(ns/scale);scale=ns;apply()},{passive:false});
var drag=null;canvas.addEventListener('pointerdown',function(e){if(e.target.closest('.dg-node'))return;drag={x:e.clientX-tx,y:e.clientY-ty};canvas.classList.add('dragging')});
window.addEventListener('pointermove',function(e){if(!drag)return;tx=e.clientX-drag.x;ty=e.clientY-drag.y;apply()});window.addEventListener('pointerup',function(){drag=null;canvas.classList.remove('dragging')});
document.getElementById('dg-fit').addEventListener('click',fit);
var themeBtn=document.getElementById('dg-theme');themeBtn.addEventListener('click',function(){var t=root.getAttribute('data-theme');var order=['auto','dark','light'];root.setAttribute('data-theme',order[(order.indexOf(t)+1)%order.length]);themeBtn.textContent='Theme: '+root.getAttribute('data-theme')});
function esc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function detail(id){var el=document.getElementById('dg-detail');if(!id){el.innerHTML='<span class="dg-empty">Select an element to see its facts.</span>';return}var n=byId[id];var h='<div><strong>'+esc(n.label)+'</strong> <span class="dg-k">'+esc(n.type)+'</span></div>';if(n.description)h+='<div>'+esc(n.description)+'</div>';
var ins=data.edges.filter(function(e){return e.to===id}),outs=data.edges.filter(function(e){return e.from===id});
if(ins.length)h+='<div class="dg-k">Upstream</div><ul>'+ins.map(function(e){return '<li>'+esc(byId[e.from].label)+(e.label?' — '+esc(e.label):'')+'</li>'}).join('')+'</ul>';
if(outs.length)h+='<div class="dg-k">Downstream</div><ul>'+outs.map(function(e){return '<li>'+esc(byId[e.to].label)+(e.label?' — '+esc(e.label):'')+'</li>'}).join('')+'</ul>';
if(n.sources&&n.sources.length)h+='<div class="dg-k">Sources'+(n.evidence?' ('+esc(n.evidence)+')':'')+'</div><ul>'+n.sources.map(function(s){return '<li><code>'+esc(s.path)+(s.lines?':'+s.lines[0]+'-'+s.lines[1]:'')+'</code>'+(s.revision?' @ <code>'+esc(s.revision.slice(0,10))+'</code>':'')+'</li>'}).join('')+'</ul>';
el.innerHTML=h}
var focusId=null;function setFocus(id){focusId=id;nodes.forEach(function(el){el.classList.remove('is-focus','is-near')});edges.forEach(function(el){el.classList.remove('is-near')});svg.classList.toggle('has-focus',!!id);
if(!id){detail(null);return}var near={};near[id]=1;edges.forEach(function(el){var f=el.getAttribute('data-from'),t=el.getAttribute('data-to');if(f===id||t===id){el.classList.add('is-near');near[f]=1;near[t]=1}});
nodes.forEach(function(el){var nid=el.getAttribute('data-id');if(nid===id)el.classList.add('is-focus');else if(near[nid])el.classList.add('is-near')});detail(id)}
nodes.forEach(function(el){el.addEventListener('click',function(e){e.stopPropagation();setFocus(el.getAttribute('data-id')===focusId?null:el.getAttribute('data-id'))});el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click()}})});
canvas.addEventListener('click',function(){setFocus(null)});window.addEventListener('keydown',function(e){if(e.key==='Escape'){setFocus(null);search.value='';runSearch()}});
var search=document.getElementById('dg-search');function runSearch(){var q=search.value.trim().toLowerCase();svg.classList.toggle('has-search',!!q);nodes.forEach(function(el){var n=byId[el.getAttribute('data-id')];var hit=!!q&&(n.label.toLowerCase().indexOf(q)>=0||n.id.toLowerCase().indexOf(q)>=0||(n.description||'').toLowerCase().indexOf(q)>=0);el.classList.toggle('is-hit',hit)})}
search.addEventListener('input',runSearch);
Array.prototype.forEach.call(document.querySelectorAll('.dg-view'),function(btn){btn.addEventListener('click',function(){var ids=btn.getAttribute('data-focus').split(',');var pressed=btn.getAttribute('aria-pressed')==='true';Array.prototype.forEach.call(document.querySelectorAll('.dg-view'),function(b){b.setAttribute('aria-pressed','false')});
nodes.forEach(function(el){el.classList.remove('is-focus','is-near')});edges.forEach(function(el){el.classList.remove('is-near')});if(pressed){svg.classList.remove('has-focus');detail(null);return}btn.setAttribute('aria-pressed','true');svg.classList.add('has-focus');
nodes.forEach(function(el){if(ids.indexOf(el.getAttribute('data-id'))>=0)el.classList.add('is-near')});edges.forEach(function(el){if(ids.indexOf(el.getAttribute('data-from'))>=0&&ids.indexOf(el.getAttribute('data-to'))>=0)el.classList.add('is-near')});detail(ids[0])})});
detail(null);fit();window.addEventListener('resize',fit);
})();
`;

/** The facts the viewer panel needs, copied from the validated document (never from the SVG). */
export function viewerData(doc: Diagram, scene: Scene): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } {
  const nodes = scene.nodes.map((n) => {
    const out: Record<string, unknown> = { id: n.id, label: n.label, type: n.type };
    if (n.description) out.description = n.description;
    if (n.evidence) out.evidence = n.evidence;
    if (n.sources) out.sources = n.sources;
    return out;
  });
  const edges = scene.edges.map((e) => {
    const out: Record<string, unknown> = { id: e.id, from: e.from, to: e.to };
    if (e.label) out.label = e.label;
    return out;
  });
  return { nodes, edges };
}

export function wrapHtml(doc: Diagram, scene: Scene, svg: string, opts: HtmlOptions): string {
  const data = JSON.stringify(viewerData(doc, scene)).replace(/</g, '\\u003c');
  const legend = scene.legend.length
    ? `<h2>Legend</h2><ul class="dg-legend">${scene.legend.map((l) => `<li><span class="dg-swatch" style="background:var(--dg-${l.key})"></span>${escapeXml(l.label)}</li>`).join('')}</ul>`
    : '';
  const views = doc.meta.views?.length
    ? `<h2>Views</h2><div class="dg-views">${doc.meta.views.map((v) => `<button class="dg-btn dg-view" aria-pressed="false" data-focus="${escapeXml(v.focus.join(','))}" title="${escapeXml(v.note ?? '')}">${escapeXml(v.label)}</button>`).join('')}</div>`
    : '';
  const subtitle = doc.meta.subtitle ? `<p class="dg-subtitle">${escapeXml(doc.meta.subtitle)}</p>` : '';
  return `<!doctype html>
<html lang="en" data-theme="${opts.theme}" data-diagram-kind="${doc.kind}" data-renderer="brainrouter-diagram/${escapeXml(opts.rendererVersion)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<title>${escapeXml(doc.meta.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="dg-app">
<header class="dg-bar"><h1 class="dg-title">${escapeXml(doc.meta.title)}</h1>${subtitle}<span class="dg-spacer"></span><input id="dg-search" type="search" placeholder="Search elements…" aria-label="Search elements"><button class="dg-btn" id="dg-fit" type="button">Fit</button><button class="dg-btn" id="dg-theme" type="button">Theme: ${opts.theme}</button></header>
<main class="dg-canvas" aria-label="diagram canvas"><div class="dg-stage">${svg}</div></main>
<aside class="dg-side">${legend}${views}<h2>Selected</h2><div class="dg-detail" id="dg-detail"></div><h2>Kind</h2><div class="dg-k">${doc.kind} · schema ${doc.schemaVersion}</div></aside>
</div>
<script type="application/json" id="dg-data">${data}</script>
<script>${JS}</script>
</body>
</html>
`;
}
