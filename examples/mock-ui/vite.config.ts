import { defineConfig } from 'vite';

// 5174 so it coexists with the desktop's own dev server (5173). Point the
// Browser panel at http://localhost:5174.
export default defineConfig({
  // host 127.0.0.1: bind IPv4 so the desktop host's readiness probe (which hits
  // 127.0.0.1:5174) can see us. Vite's default binds IPv6 ::1 on Windows, which
  // the probe can't reach → it thinks the app is down and mis-starts a duplicate.
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
