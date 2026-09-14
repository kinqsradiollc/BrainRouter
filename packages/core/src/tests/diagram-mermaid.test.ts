/**
 * ADR-056 D-A6 — Mermaid is an input, not an output: a flowchart's nodes,
 * shapes, links, link text, and subgraphs become a fresh workflow or
 * architecture document; styling, classes, and clicks are dropped and
 * reported; other Mermaid diagram types are refused with the reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importMermaidDiagram, parseMermaidFlowchart, MERMAID_LIMITS } from '../diagram/index.js';

const FLOW = `%% checkout flow
flowchart LR
  %%{init: {"theme": "dark"}}%%
  subgraph shop [Storefront]
    A([Start]) --> B[Add to cart]
    B --> C{Signed in?}
  end
  subgraph pay [Payments]
    C -->|yes| D[Charge card]
    C -- no --> E[[Sign-in form]]
    E --> D
    D -.-> F[(Orders DB)]
    D & E ==> G>Receipt]
  end
  G --> H([Done])
  style D fill:#f9f,stroke:#333
  classDef big font-size:20px
  class D big
  click D "https://example.test" "open"
`;

test('A6 a flowchart with subgraphs, shapes, link text, chains, and & groups becomes a workflow; styling is dropped and reported', () => {
  const out = importMermaidDiagram(FLOW);
  assert.equal(out.diagram.kind, 'workflow');
  const d = out.diagram as Extract<typeof out.diagram, { kind: 'workflow' }>;
  assert.deepEqual(d.lanes?.map((l) => [l.id, l.label]), [['shop', 'Storefront'], ['pay', 'Payments']]);
  const by = Object.fromEntries(d.nodes.map((n) => [n.id, n]));
  assert.equal(by.a.shape, 'start'); assert.equal(by.h.shape, 'end'); assert.equal(by.c.shape, 'decision'); assert.equal(by.e.shape, 'tool'); assert.equal(by.b.shape, 'step');
  assert.equal(by.a.lane, 'shop'); assert.equal(by.d.lane, 'pay'); assert.equal(by.c.label, 'Signed in?'); assert.equal(by.f.label, 'Orders DB');
  const edges = d.edges.map((e) => `${e.from}->${e.to}${e.label ? `:${e.label}` : ''}`);
  assert.ok(edges.includes('c->d:yes') && edges.includes('c->e:no') && edges.includes('d->g:then') && edges.includes('e->g:then') && edges.includes('g->h:then'), edges.join(' '));
  assert.ok(out.notes.some((n) => /unlabeled link\(s\) given a default label/.test(n)));
  assert.equal(out.dropped.length, 5, out.dropped.join(' | '));
  assert.ok(out.dropped.every((l) => /^(%%\{|style|classDef|class |click)/.test(l)));
  assert.ok(out.notes.some((n) => /direction LR ignored/.test(n)) && out.notes.some((n) => /5 line\(s\) not transcribed/.test(n)));
  assert.ok(!JSON.stringify(out.diagram).includes('#f9f'), 'styling must never reach the document');
  assert.ok(out.validation.ok, JSON.stringify(out.validation.diagnostics ?? out.validation));
  assert.ok(out.diagram.nodes.every((n) => n.evidence === 'authored'));
});

test('A6 a service graph becomes an architecture with boundaries, inferred types, and link styles', () => {
  const src = `graph TD
  subgraph edge [Edge]
    web[Web app] --> api[API service]
  end
  api --> db[(Postgres)]
  api -.-> bus[Event bus]
  api <--> auth[Auth provider]
  api == metrics ==> mon[Monitoring]`;
  const out = importMermaidDiagram(src, { title: 'Checkout services' });
  assert.equal(out.diagram.kind, 'architecture');
  const d = out.diagram as Extract<typeof out.diagram, { kind: 'architecture' }>;
  assert.equal(d.meta.title, 'Checkout services');
  const type = Object.fromEntries(d.components.map((c) => [c.id, c.type]));
  assert.equal(type.db, 'database'); assert.equal(type.web, 'frontend'); assert.equal(type.bus, 'messagebus'); assert.equal(type.auth, 'security');
  assert.deepEqual(d.boundaries, [{ id: 'edge', label: 'Edge', kind: 'group', wraps: ['web', 'api'] }]);
  const conn = Object.fromEntries(d.connections.map((c) => [`${c.from}->${c.to}`, c]));
  assert.equal(conn['api->db'].style, 'sync'); assert.equal(conn['api->db'].label, 'uses'); assert.equal(conn['api->bus'].label, 'async'); assert.equal(conn['api->bus'].style, 'async'); assert.equal(conn['api->mon'].style, 'data'); assert.equal(conn['api->mon'].label, 'metrics'); assert.equal(conn['api->auth'].direction, 'both');
  assert.ok(out.validation.ok, JSON.stringify(out.validation));
  assert.equal(importMermaidDiagram(src, { kind: 'workflow' }).diagram.kind, 'workflow');
});

test('A6 refuses other diagram types and bounds size', () => {
  assert.throws(() => importMermaidDiagram('sequenceDiagram\n  A->>B: hi'), /only flowchart \/ graph is imported; this is a sequenceDiagram/);
  assert.throws(() => importMermaidDiagram('just words'), /no `flowchart` or `graph` header/);
  assert.throws(() => parseMermaidFlowchart('x'.repeat(MERMAID_LIMITS.chars + 1)), /over/);
  const many = `flowchart TD\n${Array.from({ length: 70 }, (_, i) => `n${i} --> n${i + 1}`).join('\n')}`;
  const out = importMermaidDiagram(many, { kind: 'workflow' });
  assert.equal((out.diagram as { nodes: unknown[] }).nodes.length, MERMAID_LIMITS.nodes);
  assert.ok(out.dropped.some((l) => /node-bound|over the/.test(l)));
});
