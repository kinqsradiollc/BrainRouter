import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build — plain SPA served from dist/ inside the packaged app.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
});
