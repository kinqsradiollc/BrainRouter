import type { AtlasGraph } from '@kinqs/brainrouter-types';

/** A representative synthetic codebase (small commerce app) for browser-only dev. */
function devFile(path: string, category: 'code' | 'config' | 'docs' | 'infra', complexity: 'simple' | 'moderate' | 'complex', lang = 'typescript') {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const type = category === 'config' ? 'config' : category === 'docs' ? 'document' : category === 'infra' ? 'resource' : 'file';
  return { id: `${type}:${path}`, type, name, filePath: path, language: lang, category, complexity } as AtlasGraph['nodes'][number];
}
const DEV_FILES: Array<[string, 'code' | 'config' | 'docs' | 'infra', 'simple' | 'moderate' | 'complex', string?]> = [
  ['src/gateway/server.ts', 'code', 'moderate'], ['src/gateway/routes.ts', 'code', 'moderate'], ['src/gateway/middleware.ts', 'code', 'simple'],
  ['src/cart/cart.ts', 'code', 'moderate'], ['src/cart/cartStore.ts', 'code', 'complex'],
  ['src/catalog/catalog.ts', 'code', 'moderate'], ['src/catalog/search.ts', 'code', 'complex'],
  ['src/checkout/checkout.ts', 'code', 'complex'], ['src/checkout/orchestrator.ts', 'code', 'complex'],
  ['src/payment/payment.ts', 'code', 'moderate'], ['src/payment/validate.ts', 'code', 'simple'],
  ['src/ui/App.tsx', 'code', 'moderate'], ['src/ui/ProductList.tsx', 'code', 'moderate'], ['src/ui/CartView.tsx', 'code', 'simple'],
  ['src/shared/types.ts', 'code', 'simple'], ['src/shared/http.ts', 'code', 'simple'],
  ['src/cart/cartStore.test.ts', 'code', 'simple'],
  // Typed service ports (Wave 3) — each module's facade over its internals.
  ['src/cart/service.ts', 'code', 'simple'], ['src/catalog/service.ts', 'code', 'simple'],
  ['src/payment/service.ts', 'code', 'simple'], ['src/checkout/service.ts', 'code', 'moderate'],
  ['package.json', 'config', 'simple', 'json'], ['tsconfig.json', 'config', 'simple', 'json'], ['Dockerfile', 'infra', 'simple', 'docker'],
  ['README.md', 'docs', 'simple', 'markdown'],
];
const DEV_IMPORTS: Array<[string, string]> = [
  ['src/gateway/server.ts', 'src/gateway/routes.ts'], ['src/gateway/server.ts', 'src/gateway/middleware.ts'],
  ['src/gateway/routes.ts', 'src/cart/cart.ts'], ['src/gateway/routes.ts', 'src/catalog/catalog.ts'], ['src/gateway/routes.ts', 'src/checkout/checkout.ts'],
  ['src/cart/cart.ts', 'src/cart/cartStore.ts'], ['src/cart/cart.ts', 'src/shared/types.ts'],
  ['src/catalog/catalog.ts', 'src/catalog/search.ts'], ['src/catalog/catalog.ts', 'src/shared/types.ts'],
  ['src/checkout/checkout.ts', 'src/checkout/orchestrator.ts'], ['src/checkout/orchestrator.ts', 'src/cart/cart.ts'],
  ['src/checkout/orchestrator.ts', 'src/catalog/catalog.ts'], ['src/checkout/orchestrator.ts', 'src/payment/payment.ts'],
  ['src/payment/payment.ts', 'src/payment/validate.ts'], ['src/payment/payment.ts', 'src/shared/http.ts'],
  ['src/ui/App.tsx', 'src/ui/ProductList.tsx'], ['src/ui/App.tsx', 'src/ui/CartView.tsx'], ['src/ui/App.tsx', 'src/shared/http.ts'],
  ['src/cart/cartStore.ts', 'src/shared/types.ts'], ['src/catalog/search.ts', 'src/shared/types.ts'],
  ['src/cart/cartStore.test.ts', 'src/cart/cartStore.ts'],
  // Service ports delegate to their module internals…
  ['src/cart/service.ts', 'src/cart/cartStore.ts'], ['src/catalog/service.ts', 'src/catalog/catalog.ts'],
  ['src/payment/service.ts', 'src/payment/payment.ts'],
  // …and checkout's port composes the cart/catalog/payment services (cross-module).
  ['src/checkout/service.ts', 'src/cart/service.ts'], ['src/checkout/service.ts', 'src/catalog/service.ts'],
  ['src/checkout/service.ts', 'src/payment/service.ts'],
];
export function devAtlasGraph(): AtlasGraph {
  const nodes = DEV_FILES.map(([p, c, cx, lang]) => devFile(p, c, cx, lang));
  const id = (p: string): string => nodes.find((n) => n.filePath === p)!.id;
  const edges: AtlasGraph['edges'] = DEV_IMPORTS.map(([a, b]) => ({ source: id(a), target: id(b), type: 'imports', weight: 0.9 }));
  // entity (class) + function symbols for the detail card and domain entities
  const sym: Array<[string, string, 'class' | 'function', string, [number, number]]> = [
    ['class:src/cart/cartStore.ts:CartStore', 'CartStore', 'class', 'src/cart/cartStore.ts', [8, 74]],
    ['class:src/catalog/catalog.ts:Product', 'Product', 'class', 'src/catalog/catalog.ts', [3, 22]],
    ['class:src/catalog/search.ts:SearchIndex', 'SearchIndex', 'class', 'src/catalog/search.ts', [5, 48]],
    ['class:src/payment/payment.ts:Charge', 'Charge', 'class', 'src/payment/payment.ts', [4, 30]],
    ['class:src/gateway/server.ts:Server', 'Server', 'class', 'src/gateway/server.ts', [6, 40]],
    ['class:src/shared/types.ts:Order', 'Order', 'class', 'src/shared/types.ts', [1, 18]],
    ['function:src/checkout/orchestrator.ts:placeOrder', 'placeOrder', 'function', 'src/checkout/orchestrator.ts', [12, 58]],
  ];
  for (const [sid, name, type, filePath, lineRange] of sym) {
    nodes.push({ id: sid, type, name, filePath, lineRange } as AtlasGraph['nodes'][number]);
    edges.push({ source: id(filePath), target: sid, type: 'contains' as const, weight: 1 });
  }
  return {
    schemaVersion: 1, kind: 'codebase',
    project: { name: 'commerce-demo', languages: ['typescript', 'json'], frameworks: ['React'], description: 'A small commerce app for the Atlas panel.', analyzedAt: '2026-06-22T00:00:00Z', totalFiles: DEV_FILES.length },
    nodes, edges, layers: [], tour: [],
  };
}

/** The dev graph with LLM enrichment applied — summaries, tags, layers, tour. */
export function devAtlasEnriched(): AtlasGraph {
  const g = devAtlasGraph();
  const sum: Record<string, string> = {
    'src/gateway/server.ts': 'HTTP gateway entry — boots the server and mounts routes.',
    'src/gateway/routes.ts': 'Maps HTTP routes to the cart, catalog, and checkout services.',
    'src/cart/cartStore.ts': 'In-memory cart persistence with add/remove/total.',
    'src/catalog/search.ts': 'Product search and filtering over the catalog.',
    'src/checkout/orchestrator.ts': 'Coordinates cart, catalog, and payment to place an order.',
    'src/payment/payment.ts': 'Simulated card payment processing and validation.',
    'src/ui/App.tsx': 'Root React component wiring the storefront UI.',
    'src/shared/types.ts': 'Shared domain types used across services.',
  };
  g.nodes = g.nodes.map((n) => (n.filePath && sum[n.filePath] ? { ...n, summary: sum[n.filePath], tags: [n.category ?? 'code'] } : n));
  const L = (p: string): string => `file:${p}`;
  g.layers = [
    { id: 'layer:gateway', name: 'API Gateway', description: 'Inbound HTTP surface and routing.', nodeIds: ['file:src/gateway/server.ts', 'file:src/gateway/routes.ts', 'file:src/gateway/middleware.ts'] },
    { id: 'layer:cart', name: 'Cart', description: 'Shopping cart state and operations.', nodeIds: [L('src/cart/cart.ts'), L('src/cart/cartStore.ts')] },
    { id: 'layer:catalog', name: 'Catalog', description: 'Product listing and search.', nodeIds: [L('src/catalog/catalog.ts'), L('src/catalog/search.ts')] },
    { id: 'layer:checkout', name: 'Checkout & Payment', description: 'Order orchestration and payment.', nodeIds: [L('src/checkout/checkout.ts'), L('src/checkout/orchestrator.ts'), L('src/payment/payment.ts'), L('src/payment/validate.ts')] },
    { id: 'layer:ui', name: 'Storefront UI', description: 'React storefront components.', nodeIds: [L('src/ui/App.tsx'), L('src/ui/ProductList.tsx'), L('src/ui/CartView.tsx')] },
    { id: 'layer:shared', name: 'Shared', description: 'Cross-cutting types and helpers.', nodeIds: [L('src/shared/types.ts'), L('src/shared/http.ts')] },
    { id: 'layer:config', name: 'Config & Docs', description: 'Build config and documentation.', nodeIds: ['config:package.json', 'config:tsconfig.json', 'resource:Dockerfile', 'document:README.md'] },
  ];
  g.tour = [
    { order: 1, title: 'Start at the gateway', description: 'server.ts boots the app and mounts routes.ts.', nodeIds: ['file:src/gateway/server.ts', 'file:src/gateway/routes.ts'] },
    { order: 2, title: 'Browse the catalog', description: 'catalog.ts + search.ts power product discovery.', nodeIds: [L('src/catalog/catalog.ts'), L('src/catalog/search.ts')] },
    { order: 3, title: 'The cart', description: 'cartStore.ts holds cart state.', nodeIds: [L('src/cart/cartStore.ts')] },
    { order: 4, title: 'Checkout flow', description: 'orchestrator.ts coordinates cart, catalog, and payment.', nodeIds: [L('src/checkout/orchestrator.ts'), L('src/payment/payment.ts')] },
    { order: 5, title: 'The storefront', description: 'App.tsx renders the UI.', nodeIds: [L('src/ui/App.tsx')] },
  ];
  // Semantic layer relationships (LLM relationship pass) — labels the Domain
  // view shows on its inter-layer edges. Only pairs with a real cross-layer
  // import edge above are labelled.
  g.layerEdges = [
    { source: 'layer:gateway', target: 'layer:cart', label: 'routes to' },
    { source: 'layer:gateway', target: 'layer:catalog', label: 'routes to' },
    { source: 'layer:gateway', target: 'layer:checkout', label: 'routes to' },
    { source: 'layer:checkout', target: 'layer:cart', label: 'reads cart from' },
    { source: 'layer:checkout', target: 'layer:catalog', label: 'looks up in' },
    { source: 'layer:checkout', target: 'layer:shared', label: 'uses' },
    { source: 'layer:cart', target: 'layer:shared', label: 'uses' },
    { source: 'layer:catalog', target: 'layer:shared', label: 'uses' },
    { source: 'layer:ui', target: 'layer:shared', label: 'calls' },
  ];
  return g;
}
