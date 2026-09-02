/**
 * Built-in browser tools for BrainRouter's embedded Chromium surface.
 *
 * Every live command uses the per-Agent browser-control runtime port injected by
 * Desktop. There is intentionally no Playwright/Chrome fallback: CLI, reviewer,
 * child, remote-brain, and closed-window contexts are unavailable instead of
 * spawning a second browser.
 */

const objSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const tabId = { type: 'string', maxLength: 256, description: 'Stable tab id from browser_list_tabs.' };
const ref = { type: 'string', maxLength: 512, description: 'Opaque element ref from browser_snapshot; invalid after navigation.' };
const testID = { type: 'string', maxLength: 512, description: 'Compatibility locator from the workspace UI map.' };
const pageRevision = { type: 'integer', minimum: 0, description: 'Page revision returned with the semantic snapshot.' };
const tabProps = { tabId };
const targetProps = { tabId, ref, testID, pageRevision };

export async function activate(host) {
  let pkg;
  try {
    pkg = await import('../../dist/browser/index.js');
  } catch (err) {
    host.log('browser engine not built — browser_* tools unavailable', { error: String((err && err.message) || err) });
    return;
  }

  const session = () => pkg.getUiTestSession(host.workspaceRoot);
  const unavailable = (kind) => pkg.serializeBrowserControlResult(
    pkg.failure(kind, 'unavailable', 'In-app browser control is unavailable in this agent context.'),
  );
  const hasPort = (runtime) => !!runtime?.browserControlPort;
  const invoke = async (runtime, command) => {
    const backend = new pkg.BrowserControlBackend(runtime?.browserControlPort);
    return pkg.serializeBrowserControlResult(await backend.perform(command, { signal: runtime?.signal }));
  };
  const boundedJson = (data, kind) => {
    const result = pkg.normalizeBrowserControlResult({ ok: true, kind, durationMs: 0, data }, kind);
    return JSON.stringify(result.data ?? null);
  };
  const reg = ({ name, description, inputSchema, accessTier, actionKind, parallelSafe = false, audited = false, handle }) =>
    host.registerTool({
      name,
      description,
      inputSchema,
      accessTier,
      actionKind,
      parallelSafe,
      audited,
      runtimePort: 'browser-control',
      handle,
    });

  const read = (name, description, inputSchema, handle, parallelSafe = false) =>
    reg({ name, description, inputSchema, accessTier: 'read', actionKind: 'read_only', parallelSafe, handle });
  const network = (name, description, inputSchema, handle) =>
    reg({ name, description, inputSchema, accessTier: 'read', actionKind: 'network', audited: true, handle });
  const computer = (name, description, inputSchema, handle) =>
    reg({ name, description, inputSchema, accessTier: 'shell', actionKind: 'computer', handle });

  // Read-only observations. Heavy observations are explicit and bounded.
  read('browser_capabilities', 'Report the operations supported by the embedded BrainRouter browser.', objSchema(),
    (_args, runtime) => invoke(runtime, { kind: 'capabilities' }));
  read('browser_list_tabs', 'List embedded browser tabs with stable ids, URL/title, loading, history, crash, and active state.', objSchema(),
    (_args, runtime) => invoke(runtime, { kind: 'tabs.list' }));
  read('browser_get_state', 'Get navigation and lifecycle state for one tab (defaults to the visible tab).', objSchema(tabProps),
    (args, runtime) => invoke(runtime, { kind: 'page.state', tabId: args.tabId }));
  read('browser_snapshot', 'Capture a bounded semantic snapshot of the page (interactive nodes with opaque, page-revision-bound refs). scope "page" also returns visible nodes scrolled out of the viewport (flagged inViewport:false) so you need not scroll-and-re-snapshot; open shadow-DOM roots are walked.', objSchema({ ...tabProps, maxChars: { type: 'integer', minimum: 1000, maximum: 200000 }, scope: { type: 'string', enum: ['viewport', 'page'], description: 'viewport (default) or page (include scrolled-out visible nodes).' } }),
    (args, runtime) => invoke(runtime, { kind: 'page.snapshot', tabId: args.tabId, maxChars: args.maxChars, scope: args.scope }));
  read('browser_screenshot', 'Capture the current tab as a bounded browser artifact. This is explicit and is not run after normal actions.', objSchema({ ...tabProps, fullPage: { type: 'boolean' } }),
    (args, runtime) => invoke(runtime, { kind: 'page.screenshot', tabId: args.tabId, fullPage: args.fullPage }));
  read('browser_console', 'Read a bounded page-console batch. Sensitive fields are redacted.', objSchema({ ...tabProps, after: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    (args, runtime) => invoke(runtime, { kind: 'page.console', tabId: args.tabId, after: args.after, limit: args.limit }));
  read('browser_network', 'Read a bounded network-event batch without cookies, authorization headers, or request bodies.', objSchema({ ...tabProps, after: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    (args, runtime) => invoke(runtime, { kind: 'page.network', tabId: args.tabId, after: args.after, limit: args.limit }));
  read('browser_downloads', 'List bounded download metadata and progress without file contents.', objSchema({ ...tabProps, after: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    (args, runtime) => invoke(runtime, { kind: 'page.downloads', tabId: args.tabId, after: args.after, limit: args.limit }));

  // UI-map compatibility helpers. They stay hidden unless a live browser port
  // exists, but read only the manifest and do not incur a page observation.
  read('browser_list_screens', 'List screens in the workspace UI map (id, title, route, element count).', objSchema(), (_args, runtime) => {
    if (!hasPort(runtime)) return unavailable('manifest.listScreens');
    return boundedJson(session().layer.listScreens().slice(0, 200), 'manifest.listScreens');
  }, true);
  read('browser_get_screen', 'Get one UI-map screen and its test-id elements.', objSchema({ screen: { type: 'string', maxLength: 256 } }, ['screen']), (args, runtime) => {
    if (!hasPort(runtime)) return unavailable('manifest.getScreen');
    const screen = session().layer.getScreen(String(args.screen || ''));
    return screen ? boundedJson({ ...screen, elements: screen.elements.slice(0, 500) }, 'manifest.getScreen') : `unknown screen: ${String(args.screen || '')}`;
  }, true);
  read('browser_find_element', 'Find UI-map elements by a case-insensitive id/test-id/label substring.', objSchema({ query: { type: 'string', maxLength: 256 } }, ['query']), (args, runtime) => {
    if (!hasPort(runtime)) return unavailable('manifest.findElement');
    return boundedJson(session().layer.findElement(String(args.query || '')).slice(0, 200), 'manifest.findElement');
  }, true);
  read('browser_assert_visible', 'Wait until an opaque ref or compatibility test-id is visible.', objSchema({ ...targetProps, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 } }),
    (args, runtime) => invoke(runtime, { kind: 'page.assertVisible', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, timeoutMs: args.timeoutMs }));

  // Network/navigation operations. They are explicitly audited as network calls.
  network('browser_open_tab', 'Open a new embedded tab, optionally at an absolute safe HTTP(S) URL.', objSchema({ url: { type: 'string', maxLength: 4096 }, activate: { type: 'boolean' } }),
    (args, runtime) => invoke(runtime, { kind: 'tabs.open', url: args.url, activate: args.activate }));
  network('browser_navigate', 'Navigate a tab to an arbitrary safe absolute HTTP(S) URL, or to a named UI-map screen.', objSchema({ ...tabProps, url: { type: 'string', maxLength: 4096 }, screen: { type: 'string', maxLength: 256 } }), async (args, runtime) => {
    let url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : '';
    if (!url && args.screen) {
      const screen = session().layer.getScreen(String(args.screen));
      if (!screen) return pkg.serializeBrowserControlResult(pkg.failure('page.navigate', 'invalid_request', `Unknown screen: ${String(args.screen)}`));
      const route = String(screen.route || '');
      if (/^https?:\/\//i.test(route)) url = route;
      else if (session().baseUrl && route) url = new URL(route, session().baseUrl).toString();
      else if (session().baseUrl) url = session().baseUrl;
      else return pkg.serializeBrowserControlResult(pkg.failure('page.navigate', 'invalid_request', `Screen ${String(args.screen)} has no absolute URL or Browser base URL.`));
    }
    return invoke(runtime, { kind: 'page.navigate', tabId: args.tabId, url });
  });
  network('browser_back', 'Navigate the tab backward in history.', objSchema(tabProps),
    (args, runtime) => invoke(runtime, { kind: 'page.back', tabId: args.tabId }));
  network('browser_forward', 'Navigate the tab forward in history.', objSchema(tabProps),
    (args, runtime) => invoke(runtime, { kind: 'page.forward', tabId: args.tabId }));
  network('browser_reload', 'Reload the tab, optionally bypassing cache.', objSchema({ ...tabProps, ignoreCache: { type: 'boolean' } }),
    (args, runtime) => invoke(runtime, { kind: 'page.reload', tabId: args.tabId, ignoreCache: args.ignoreCache }));
  network('browser_stop', 'Stop the tab\'s current navigation.', objSchema(tabProps),
    (args, runtime) => invoke(runtime, { kind: 'page.stop', tabId: args.tabId }));
  network('browser_wait', 'Wait for load state, URL text, page text, or an element ref/test-id, with a bounded timeout.', objSchema({
    ...targetProps,
    loadState: { type: 'string', enum: ['domcontentloaded', 'load', 'networkidle'] },
    urlIncludes: { type: 'string', maxLength: 2048 },
    text: { type: 'string', maxLength: 4096 },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
  }), (args, runtime) => invoke(runtime, { kind: 'page.wait', tabId: args.tabId, loadState: args.loadState, urlIncludes: args.urlIncludes, text: args.text, ref: args.ref, testID: args.testID, timeoutMs: args.timeoutMs }));

  // Visible computer interactions. Shell tier + computer action kind means they
  // inherit the existing local-computer policy and audit boundary.
  computer('browser_select_tab', 'Select and reveal a tab by stable id.', objSchema({ tabId }, ['tabId']),
    (args, runtime) => invoke(runtime, { kind: 'tabs.select', tabId: args.tabId }));
  computer('browser_close_tab', 'Close a tab by stable id.', objSchema({ tabId }, ['tabId']),
    (args, runtime) => invoke(runtime, { kind: 'tabs.close', tabId: args.tabId }));
  computer('browser_reopen_tab', 'Reopen the most recently closed embedded tab.', objSchema(),
    (_args, runtime) => invoke(runtime, { kind: 'tabs.reopen' }));
  computer('browser_reorder_tab', 'Move a tab to a zero-based position.', objSchema({ tabId, index: { type: 'integer', minimum: 0, maximum: 999 } }, ['tabId', 'index']),
    (args, runtime) => invoke(runtime, { kind: 'tabs.reorder', tabId: args.tabId, index: args.index }));

  const coordX = { type: 'number', minimum: 0, maximum: 100000, description: 'Viewport CSS-pixel x from the last browser_screenshot; a target when no ref/testID is given.' };
  const coordY = { type: 'number', minimum: 0, maximum: 100000, description: 'Viewport CSS-pixel y from the last browser_screenshot; a target when no ref/testID is given.' };
  const clickSchema = objSchema({ ...targetProps, x: coordX, y: coordY, button: { type: 'string', enum: ['left', 'middle', 'right'] }, modifiers: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 32 } } });
  computer('browser_click', 'Click an opaque semantic ref, a compatibility test-id, or a screenshot {x,y} point (a coordinate hit on a credential field is refused).', clickSchema,
    (args, runtime) => invoke(runtime, { kind: 'page.click', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, x: args.x, y: args.y, button: args.button, modifiers: args.modifiers }));
  computer('browser_double_click', 'Double-click an opaque semantic ref, a compatibility test-id, or a screenshot {x,y} point.', clickSchema,
    (args, runtime) => invoke(runtime, { kind: 'page.doubleClick', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, x: args.x, y: args.y, button: args.button, modifiers: args.modifiers }));
  computer('browser_tap', 'Compatibility alias: click an element by UI-map test-id.', objSchema({ ...tabProps, testID }, ['testID']),
    (args, runtime) => invoke(runtime, { kind: 'page.click', tabId: args.tabId, testID: args.testID }));
  computer('browser_hover', 'Hover an opaque semantic ref, a compatibility test-id, or a screenshot {x,y} point.', objSchema({ ...targetProps, x: coordX, y: coordY }),
    (args, runtime) => invoke(runtime, { kind: 'page.hover', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, x: args.x, y: args.y }));
  computer('browser_type', 'Type bounded text into an opaque ref/test-id; replace defaults to the page manager\'s safe behavior.', objSchema({ ...targetProps, text: { type: 'string', maxLength: 20000 }, replace: { type: 'boolean' } }, ['text']),
    (args, runtime) => invoke(runtime, { kind: 'page.type', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, text: args.text, replace: args.replace }));
  computer('browser_press', 'Press a key or shortcut, optionally targeting an element.', objSchema({ ...targetProps, key: { type: 'string', maxLength: 128 }, modifiers: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 32 } } }, ['key']),
    (args, runtime) => invoke(runtime, { kind: 'page.press', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, key: args.key, modifiers: args.modifiers }));
  computer('browser_scroll', 'Scroll the page or a referenced element by bounded CSS-pixel deltas.', objSchema({ ...targetProps, deltaX: { type: 'number', minimum: -100000, maximum: 100000 }, deltaY: { type: 'number', minimum: -100000, maximum: 100000 } }),
    (args, runtime) => invoke(runtime, { kind: 'page.scroll', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, deltaX: args.deltaX, deltaY: args.deltaY }));
  computer('browser_drag', 'Drag between two opaque refs within one page revision, or between two screenshot {x,y} points.', objSchema({ ...tabProps, fromRef: ref, toRef: ref, fromX: coordX, fromY: coordY, toX: coordX, toY: coordY, pageRevision }),
    (args, runtime) => invoke(runtime, { kind: 'page.drag', tabId: args.tabId, fromRef: args.fromRef, toRef: args.toRef, fromX: args.fromX, fromY: args.fromY, toX: args.toX, toY: args.toY, pageRevision: args.pageRevision }));
  computer('browser_select_option', 'Select one or more bounded option values.', objSchema({ ...targetProps, values: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 1024 } } }, ['values']),
    (args, runtime) => invoke(runtime, { kind: 'page.select', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, values: args.values }));
  computer('browser_check', 'Set a checkbox/radio-like control to the requested checked state.', objSchema({ ...targetProps, checked: { type: 'boolean' } }, ['checked']),
    (args, runtime) => invoke(runtime, { kind: 'page.check', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, checked: args.checked }));
  computer('browser_upload_files', 'Set one or more workspace-relative files on a file-input element. Absolute paths and parent traversal are rejected before Desktop receives the command.', objSchema({
    ...targetProps,
    files: {
      type: 'array', minItems: 1, maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 4096, description: 'Path relative to the active workspace root.' },
    },
  }, ['files']),
  (args, runtime) => invoke(runtime, { kind: 'page.setFiles', tabId: args.tabId, ref: args.ref, testID: args.testID, pageRevision: args.pageRevision, files: args.files }));
  computer('browser_set_device', 'Set a bounded browser viewport/device emulation for the tab.', objSchema({
    ...tabProps,
    name: { type: 'string', maxLength: 128 }, width: { type: 'integer', minimum: 200, maximum: 10000 },
    height: { type: 'integer', minimum: 200, maximum: 10000 }, deviceScaleFactor: { type: 'number', minimum: 0.25, maximum: 8 }, isMobile: { type: 'boolean' },
  }, ['width', 'height']), (args, runtime) => invoke(runtime, { kind: 'page.setDevice', tabId: args.tabId, device: { name: args.name || 'custom', width: args.width, height: args.height, deviceScaleFactor: args.deviceScaleFactor, isMobile: args.isMobile } }));
  computer('browser_download_action', 'Pause, resume, cancel, open, or reveal a known browser download.', objSchema({ downloadId: { type: 'string', maxLength: 256 }, action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'open', 'reveal'] } }, ['downloadId', 'action']),
    (args, runtime) => invoke(runtime, { kind: 'download.action', downloadId: args.downloadId, action: args.action }));
  computer('browser_dialog', 'Accept or dismiss the active page dialog; prompt text is bounded and never read back.', objSchema({ ...tabProps, action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string', maxLength: 4096 } }, ['action']),
    (args, runtime) => invoke(runtime, { kind: 'dialog.respond', tabId: args.tabId, action: args.action, promptText: args.promptText }));
  computer('browser_permission', 'Respond to a pending per-origin site permission prompt.', objSchema({ origin: { type: 'string', maxLength: 4096 }, permission: { type: 'string', maxLength: 128 }, decision: { type: 'string', enum: ['allow', 'deny'] } }, ['origin', 'permission', 'decision']),
    (args, runtime) => invoke(runtime, { kind: 'permission.respond', origin: args.origin, permission: args.permission, decision: args.decision }));
  computer('browser_run_flow', 'Run up to 50 compatibility UI-map steps in order; stops at the first failure.', objSchema({
    steps: { type: 'array', maxItems: 50, items: { type: 'object', properties: { action: { type: 'string', enum: ['navigate', 'tap', 'type', 'assertVisible'] }, target: { type: 'string', maxLength: 512 }, text: { type: 'string', maxLength: 20000 } }, required: ['action', 'target'], additionalProperties: false } },
  }, ['steps']), async (args, runtime) => {
    if (!hasPort(runtime)) return unavailable('flow.run');
    const steps = Array.isArray(args.steps) ? args.steps.slice(0, 50) : [];
    const results = [];
    for (const step of steps) {
      let command;
      if (step.action === 'tap') command = { kind: 'page.click', testID: step.target };
      else if (step.action === 'type') command = { kind: 'page.type', testID: step.target, text: step.text || '' };
      else if (step.action === 'assertVisible') command = { kind: 'page.assertVisible', testID: step.target };
      else if (step.action === 'navigate') {
        const screen = session().layer.getScreen(String(step.target));
        const route = screen && String(screen.route || '');
        const url = /^https?:\/\//i.test(route) ? route : route && session().baseUrl ? new URL(route, session().baseUrl).toString() : '';
        if (!url) {
          results.push(pkg.failure('page.navigate', 'invalid_request', `Unknown screen or base URL: ${String(step.target)}`));
          break;
        }
        command = { kind: 'page.navigate', url };
      } else {
        results.push(pkg.failure('flow.run', 'invalid_request', `Unsupported flow action: ${String(step.action)}`));
        break;
      }
      const result = await new pkg.BrowserControlBackend(runtime.browserControlPort).perform(command, { signal: runtime.signal });
      results.push(result);
      if (!result.ok) break;
    }
    return pkg.serializeBrowserControlResult(pkg.normalizeBrowserControlResult({ ok: true, kind: 'flow.run', durationMs: 0, data: { results } }, 'flow.run'));
  });

  host.log(`browser: registered ${39} embedded browser tools`);
}
