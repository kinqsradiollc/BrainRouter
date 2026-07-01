import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only model-probe proxy. The browser preview can't fetch a provider's
 * `/models` directly — it's cross-origin and most LLM gateways send NO CORS
 * headers (ZenMux, OpenAI, …), so the browser blocks it. This middleware runs in
 * the vite Node server (no CORS) and performs the fetch on the browser's behalf,
 * exactly like the Electron app does host-side. devBridge POSTs
 * `{ endpoint, apiKey, apiVersion }` here and gets `{ models, error? }` back.
 * Serve-only: the packaged Electron app never uses this (it has its own host).
 */
function modelProbeProxy(): Plugin {
  return {
    name: 'brp-model-probe-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__brp/models', (req, res) => {
        const send = (obj: unknown, code = 200): void => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(obj));
        };
        if (req.method !== 'POST') { send({ models: [], error: 'method' }, 405); return; }
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', async () => {
          let endpoint = '', apiKey = '', apiVersion = '';
          try { ({ endpoint = '', apiKey = '', apiVersion = '' } = JSON.parse(raw || '{}')); } catch { /* empty */ }
          const ep = String(endpoint).trim();
          if (!ep) { send({ models: [], error: 'no-endpoint' }); return; }
          const base = ep.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '') + '/models';
          const av = String(apiVersion).trim();
          const url = av ? base + (base.includes('?') ? '&' : '?') + 'api-version=' + encodeURIComponent(av) : base;
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 12_000);
          try {
            const r = await fetch(url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(apiKey).trim() || 'local'}` }, signal: ctrl.signal });
            if (!r.ok) { send({ models: [], error: `http-${r.status}` }); return; }
            const body = await r.json().catch(() => ({})) as { data?: Array<{ id?: unknown }> };
            const ids = [...new Set((Array.isArray(body.data) ? body.data : []).map((x) => (x && typeof x.id === 'string') ? x.id : '').filter(Boolean))].sort();
            send({ models: ids });
          } catch {
            send({ models: [], error: 'unreachable' });
          } finally {
            clearTimeout(timer);
          }
        });
      });
    },
  };
}

// Renderer build — plain SPA served from dist/ inside the packaged app.
export default defineConfig({
  plugins: [react(), modelProbeProxy()],
  base: './',
  build: { outDir: 'dist' },
  // Monaco ships its language services as web workers. Emit them as same-origin
  // ES-module chunks (via the `?worker` imports in src/lib/editor/monacoEnv.ts)
  // so they load under the packaged file:// CSP — never the blocked blob/CDN worker.
  worker: { format: 'es' },
  optimizeDeps: { include: ['monaco-editor'] },
});
