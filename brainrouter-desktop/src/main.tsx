import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/primitives/ErrorBoundary.js';
import { bootstrapAppearanceDocument } from './App/hooks/index.js';
import './theme.css';

/**
 * In Electron the preload provides `window.brainrouter` before this runs. In a
 * plain browser (vite dev, UI work without the shell) the dev bridge stands in
 * with canned data — loaded lazily and only then, so its fixtures are never
 * part of the app's initial JavaScript. The first render waits for it because
 * the shell's hooks read the bridge as they mount.
 */
async function boot(): Promise<void> {
  if (!(window as { brainrouter?: unknown }).brainrouter) {
    const { installDevBridge } = await import('./devBridge.js');
    installDevBridge();
  }
  // Reads the bridge's appearance snapshot; must follow the bridge, precede the render.
  bootstrapAppearanceDocument();
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void boot();
