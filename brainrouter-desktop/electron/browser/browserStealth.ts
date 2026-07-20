/**
 * Fingerprint hardening for the in-app browser.
 *
 * Attaching the CDP debugger (which we do for dialogs, screenshots, DOM, and
 * device emulation) flips Chromium's `navigator.webdriver` flag on and leaves a
 * few other automation tells, so ordinary sites mis-classify our REAL, headed
 * Chromium as a bot and block or stall it (the "loads forever" symptom). This
 * script normalizes those tells so the browser presents as an ordinary user's
 * Chrome — the same category as playwright-stealth / undetected-chromedriver.
 *
 * SCOPE: this only removes automation *fingerprint leaks* on a real browser. It
 * does NOT solve CAPTCHAs, defeat Cloudflare Turnstile / reCAPTCHA, or do
 * behavioral ("humanize") anti-abuse evasion — deliberately out of scope.
 *
 * Injected via `Page.addScriptToEvaluateOnNewDocument`, so it runs in the page's
 * MAIN world before any page script, on every navigation and sub-frame. Every
 * patch is individually try/caught: a failure degrades to the native value, it
 * never throws into the page.
 */

/** The init script source, evaluated in the page main world before page scripts. */
export const STEALTH_INIT_SCRIPT = String.raw`
(() => {
  const safe = (fn) => { try { fn(); } catch (_e) { /* leave native value */ } };
  const def = (obj, prop, get) => safe(() => Object.defineProperty(obj, prop, { get, configurable: true }));

  // 1) navigator.webdriver — CDP attach sets this to true; a real browser reports false/undefined.
  safe(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  });
  safe(() => { if (navigator.webdriver) delete Navigator.prototype.webdriver; });

  // 2) navigator.languages — keep consistent with Accept-Language / UA.
  safe(() => {
    if (!navigator.languages || navigator.languages.length === 0) {
      def(navigator, 'languages', () => ['en-US', 'en']);
    }
  });

  // 3) window.chrome — a real Chrome exposes this object; some embeddings don't.
  safe(() => {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  });

  // 4) navigator.plugins / mimeTypes — headless/automation often reports an empty
  //    list; give a realistic, non-empty PDF-viewer set (matches modern Chrome).
  safe(() => {
    if (navigator.plugins && navigator.plugins.length > 0) return;
    const make = (name, filename, desc) => ({ name, filename, description: desc, length: 1 });
    const plugins = [
      make('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      make('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      make('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    def(navigator, 'plugins', () => Object.assign(plugins, { item: (i) => plugins[i] || null, namedItem: (n) => plugins.find((p) => p.name === n) || null }));
  });

  // 5) permissions.query — real Chrome reconciles Notification.permission with the
  //    permissions API; automation leaves them inconsistent (a common tell).
  safe(() => {
    const original = navigator.permissions && navigator.permissions.query;
    if (!original) return;
    navigator.permissions.query = function (params) {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return original.apply(this, arguments);
    };
  });

  // 6) WebGL vendor/renderer — ONLY rewrite when the GPU string reveals a software
  //    rasterizer (SwiftShader/llvmpipe), which flags a virtualized/automation host;
  //    a real hardware GPU string is left untouched (don't spoof a real fingerprint).
  safe(() => {
    const swField = 37445; // UNMASKED_VENDOR_WEBGL
    const rnField = 37446; // UNMASKED_RENDERER_WEBGL
    const patch = (proto) => {
      if (!proto) return;
      const getParam = proto.getParameter;
      proto.getParameter = function (p) {
        const value = getParam.apply(this, arguments);
        if ((p === swField || p === rnField) && typeof value === 'string' && /swiftshader|llvmpipe|software/i.test(value)) {
          return p === swField ? 'Intel Inc.' : 'Intel Iris OpenGL Engine';
        }
        return value;
      };
    };
    patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  });

  // 7) sane hardware hints when missing/zero (automation sometimes reports 0).
  safe(() => { if (!navigator.hardwareConcurrency) def(navigator, 'hardwareConcurrency', () => 8); });
  safe(() => { if ('deviceMemory' in navigator && !navigator.deviceMemory) def(navigator, 'deviceMemory', () => 8); });
})();
`;
