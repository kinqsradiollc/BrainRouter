#!/usr/bin/env node

/**
 * Thin CommonJS shim that runs BEFORE the real ESM CLI entrypoint.
 *
 * Why CJS for the bin: ESM hoists all `import` statements above any
 * top-level code in the module that owns them. The CLI imports
 * `node:sqlite` transitively via `config/config.ts`, which triggers
 * Node's `ExperimentalWarning` the FIRST time the module is touched —
 * and that happens during import resolution, before any line of code
 * in `src/index.ts` runs. So a warning filter installed inside that
 * file always fires too late.
 *
 * This shim does three things synchronously, with zero ESM imports
 * blocking it, and only then hands off:
 *
 *   1. Remove Node's default "warning" printer.
 *   2. Install a filtered listener that drops `ExperimentalWarning`
 *      (sqlite, ESM in older Node) and dotenv self-promotion lines.
 *   3. Override `process.emitWarning` so future direct callers also
 *      route through the same filter.
 *
 * Anything BrainRouter itself emits via `process.emitWarning('…',
 * 'BrainRouterWarning')` (or any non-suppressible type) flows through
 * unchanged. NODE_NO_WARNINGS=1 would silence those too, which is why
 * we don't just set that env.
 *
 * The shim then dynamically imports the ESM entry. Dynamic `import()`
 * is the only way to load ESM from CJS; it returns a promise we await
 * so an unhandled rejection during boot still surfaces as an error.
 */

function isSuppressibleWarning(message, type) {
  const looksExperimental =
    type === 'ExperimentalWarning' ||
    /experimental feature|SQLite is an experimental/i.test(message);
  const looksDotenvNoise = /dotenv@\d|dotenvx|dotenv\.org/i.test(message);
  return looksExperimental || looksDotenvNoise;
}

for (const listener of process.listeners('warning')) {
  process.removeListener('warning', listener);
}
process.on('warning', (warning) => {
  const message = (warning && warning.message) || '';
  const type = (warning && warning.name) || '';
  if (isSuppressibleWarning(message, type)) return;
  process.stderr.write(`(node:${process.pid}) ${type || 'Warning'}: ${message || warning}\n`);
});

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = function emitWarning(warning, ...rest) {
  const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  const type =
    typeof rest[0] === 'string' ? rest[0] :
    (rest[0] && typeof rest[0] === 'object' && 'type' in rest[0]) ? rest[0].type :
    (warning && warning.name) || '';
  if (isSuppressibleWarning(message, type)) return;
  return originalEmitWarning(warning, ...rest);
};

// Path to the compiled ESM entry, resolved relative to this shim.
const path = require('node:path');
const url = require('node:url');
const entry = path.resolve(__dirname, '..', 'dist', 'index.js');
import(url.pathToFileURL(entry).href).catch((err) => {
  // Surface boot-time errors verbatim — a silent exit would just look like
  // the CLI never started.
  process.stderr.write(`brainrouter: failed to load CLI entrypoint: ${(err && err.stack) || err}\n`);
  process.exit(1);
});
