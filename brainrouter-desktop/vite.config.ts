import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build — plain SPA served from dist/ inside the packaged app.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  // Monaco ships its language services as web workers. Emit them as same-origin
  // ES-module chunks (via the `?worker` imports in src/lib/editor/monacoEnv.ts)
  // so they load under the packaged file:// CSP — never the blocked blob/CDN worker.
  worker: { format: 'es' },
  optimizeDeps: { include: ['monaco-editor'] },
});
