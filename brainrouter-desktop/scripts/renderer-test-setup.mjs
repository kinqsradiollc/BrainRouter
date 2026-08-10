/**
 * ADR-035 — the one `--import` the renderer test run needs.
 *
 * ## What it owns
 *
 * Two setup steps that must happen before any test module is evaluated, and
 * nothing else:
 *
 * 1. **The stylesheet hooks** (`renderer-test-hooks.mjs`), registered rather
 *    than passed as `--loader` so this stays on Node's supported API.
 * 2. **`IS_REACT_ACT_ENVIRONMENT`.** React only lets `act()` flush effects when
 *    this global is set. Without it every `useEffect` in the tree is deferred
 *    past the assertion and a test of an effect-driven surface — which is what
 *    the compose form is — silently checks the render before its effects ran.
 *
 * ## Invariants
 *
 * 1. **No test-only behaviour reaches the app.** This file is only ever loaded
 *    by the `test` script's `--import`; nothing under `src/` imports it.
 * 2. **It sets globals, it does not stub the app.** Fakes for the capture
 *    bridge, the org context and the meetings API belong to the test that needs
 *    them, where the assertion can see them.
 */
import { register } from 'node:module';

register('./renderer-test-hooks.mjs', import.meta.url);

// React reads this off `globalThis` at the moment `act` runs, not at import.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
