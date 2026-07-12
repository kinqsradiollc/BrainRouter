/**
 * Built-in extension: ui-test — exposes the web UI-testing command layer to the
 * agent as `ui_*` tools. They share the SAME headed browser + manifest as the
 * Desktop "UI Tests" panel (via the package's per-workspace session), so the
 * panel and the agent are two consumers of one command layer.
 *
 * Registered at access tier `read` / action `read_only`: these drive an EXTERNAL
 * dev-server browser (never the workspace filesystem), so they're useful in the
 * agent's look-and-verify mode. Real safety lives inside the command layer. Note
 * the live exec-policy gate keys action kind by NAME and treats unlisted tools as
 * read_only — registering read/read_only here keeps declared == effective.
 *
 * Plain ESM (no build step). It deep-imports the built engine; if that package
 * isn't built, activation fails soft (the loader is fault-isolated) and the agent
 * simply has no ui_* tools.
 */

const objSchema = (properties, required) => ({ type: 'object', properties: properties || {}, required: required || [] });

function formatResult(r) {
  if (!r) return 'no result';
  const head = `${r.ok ? 'OK' : 'FAIL'} ${r.command}${r.testID ? ' ' + r.testID : ''}${r.screen ? ' @' + r.screen : ''} (${r.durationMs}ms)`;
  const lines = [head];
  if (r.value !== undefined && r.value !== null) lines.push('value: ' + JSON.stringify(r.value));
  if (r.error) lines.push('error: ' + r.error);
  if (r.screenshot) lines.push('screenshot: ' + r.screenshot);
  if (r.a11y) lines.push('a11y: ' + JSON.stringify(r.a11y).slice(0, 4000));
  return lines.join('\n');
}

export async function activate(host) {
  let pkg;
  try {
    pkg = await import('@kinqs/brainrouter-ui-test/dist/index.js');
  } catch (err) {
    host.log('ui-test engine not built — ui_* tools unavailable', { error: String((err && err.message) || err) });
    return;
  }
  const { getUiTestSession, runFlow } = pkg;
  const session = () => getUiTestSession(host.workspaceRoot);

  const reg = (name, description, inputSchema, parallelSafe, handle) =>
    host.registerTool({ name, description, inputSchema, accessTier: 'read', actionKind: 'read_only', parallelSafe, handle });

  // --- query helpers (manifest-only, keep agent context small) ---
  reg(
    'ui_list_screens',
    "List the screens in the workspace web app's UI map (id, title, route, element count). If empty, run Extract in the UI Tests panel first.",
    objSchema({}),
    true,
    async () => {
      const screens = session().layer.listScreens();
      if (!screens.length) return 'No UI map yet — extract it via the UI Tests panel (or no data-testid elements were found).';
      return JSON.stringify(screens);
    },
  );

  reg(
    'ui_get_screen',
    "Get one screen's elements (testID, type, action, label) from the UI map — load only the screen you need.",
    objSchema({ screen: { type: 'string', description: 'The screen id from ui_list_screens.' } }, ['screen']),
    true,
    async (args) => {
      const s = session().layer.getScreen(String(args.screen || ''));
      return s ? JSON.stringify(s) : `unknown screen: ${args.screen}`;
    },
  );

  reg(
    'ui_find_element',
    'Find elements in the UI map by a case-insensitive substring of their testID / id / label.',
    objSchema({ query: { type: 'string', description: 'Substring to match.' } }, ['query']),
    true,
    async (args) => JSON.stringify(session().layer.findElement(String(args.query || ''))),
  );

  // --- action commands (drive the headed browser) ---
  reg(
    'ui_navigate',
    'Navigate the headed browser to a screen (by id) — uses the dev-server URL set in the UI Tests panel.',
    objSchema({ screen: { type: 'string' } }, ['screen']),
    false,
    async (args) => formatResult(await session().layer.navigate(String(args.screen || ''))),
  );

  reg(
    'ui_tap',
    'Tap/click an element by its testID (or manifest id) in the headed browser.',
    objSchema({ testID: { type: 'string' } }, ['testID']),
    false,
    async (args) => formatResult(await session().layer.tap(String(args.testID || ''))),
  );

  reg(
    'ui_type',
    'Type text into an input element by its testID.',
    objSchema({ testID: { type: 'string' }, text: { type: 'string' } }, ['testID', 'text']),
    false,
    async (args) => formatResult(await session().layer.type(String(args.testID || ''), String(args.text || ''))),
  );

  reg(
    'ui_assert_visible',
    'Assert an element (by testID) is visible in the headed browser.',
    objSchema({ testID: { type: 'string' } }, ['testID']),
    false,
    async (args) => formatResult(await session().layer.assertVisible(String(args.testID || ''))),
  );

  reg(
    'ui_set_device',
    'Set the browser viewport to a device preset (width/height in CSS px).',
    objSchema(
      {
        name: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        deviceScaleFactor: { type: 'number' },
        isMobile: { type: 'boolean' },
      },
      ['width', 'height'],
    ),
    false,
    async (args) =>
      formatResult(
        await session().setDevice({
          name: args.name || 'custom',
          width: Number(args.width),
          height: Number(args.height),
          deviceScaleFactor: args.deviceScaleFactor != null ? Number(args.deviceScaleFactor) : undefined,
          isMobile: !!args.isMobile,
        }),
      ),
  );

  reg(
    'ui_run_flow',
    'Run a sequence of UI steps in order (stops at the first failure). Each step: {action:"navigate|tap|type|assertVisible", target:"<screenId|testID>", text?:"<for type>"}.',
    objSchema({ steps: { type: 'array', items: { type: 'object' }, description: 'Ordered steps.' } }, ['steps']),
    false,
    async (args) => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const results = await runFlow(session().layer, steps);
      return results.map((r, i) => `${i + 1}. ${formatResult(r)}`).join('\n') || '(no steps)';
    },
  );

  host.log('ui-test: registered 9 ui_* tools');
}
