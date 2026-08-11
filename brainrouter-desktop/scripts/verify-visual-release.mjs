import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const DEFAULT_ASSET_DIR = fileURLToPath(new URL('../dist/assets/', import.meta.url));

const LIMITS = Object.freeze({
  mainScriptRaw: 1_750_000,
  mainScriptGzip: 525_000,
  mainStylesRaw: 550_000,
  mainStylesGzip: 95_000,
  editorScriptRaw: 4_200_000,
  editorScriptGzip: 1_100_000,
});

const REQUIRED_LAZY_CHUNKS = Object.freeze([
  'AtlasPanel-',
  'BrowserPanel-',
  'CIPanel-',
  'EditorPanel-',
  // ADR-029 — the block editor plus five database views. Listed here and not
  // only trusted to the byte budget because the budget catches the regression
  // by its SIZE, which is a number someone can be tempted to raise; this
  // catches it by its cause, which is a static import nobody meant to add.
  'NotesModeContainer-',
  'MeetingsView-',
  'WorkflowsPanel-',
]);

function assertWithin(name, value, limit) {
  if (value > limit) {
    throw new Error(`${name} is ${value} bytes; release budget is ${limit} bytes`);
  }
}

function measure(assetDir, name) {
  const bytes = fs.readFileSync(path.join(assetDir, name));
  return { name, raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
}

function largest(measurements) {
  return [...measurements].sort((a, b) => b.raw - a.raw)[0];
}

export function inspectVisualReleaseBuild(assetDir = DEFAULT_ASSET_DIR) {
  if (!fs.existsSync(assetDir)) {
    throw new Error(`Desktop build assets are missing: ${assetDir}`);
  }

  const names = fs.readdirSync(assetDir);
  for (const prefix of REQUIRED_LAZY_CHUNKS) {
    if (!names.some((name) => name.startsWith(prefix) && name.endsWith('.js'))) {
      throw new Error(`Required lazy chunk is missing: ${prefix}*.js`);
    }
  }

  const entryScripts = names
    .filter((name) => name.startsWith('index-') && name.endsWith('.js'))
    .map((name) => measure(assetDir, name));
  const entryStyles = names
    .filter((name) => name.startsWith('index-') && name.endsWith('.css'))
    .map((name) => measure(assetDir, name));
  const editorScripts = names
    .filter((name) => name.startsWith('EditorPanel-') && name.endsWith('.js'))
    .map((name) => measure(assetDir, name));

  if (!entryScripts.length || !entryStyles.length || !editorScripts.length) {
    throw new Error('Desktop build is missing an entry script, entry stylesheet, or Editor chunk');
  }

  const mainScript = largest(entryScripts);
  const mainStyles = largest(entryStyles);
  const editorScript = largest(editorScripts);

  assertWithin('Initial JavaScript', mainScript.raw, LIMITS.mainScriptRaw);
  assertWithin('Initial JavaScript (gzip)', mainScript.gzip, LIMITS.mainScriptGzip);
  assertWithin('Initial CSS', mainStyles.raw, LIMITS.mainStylesRaw);
  assertWithin('Initial CSS (gzip)', mainStyles.gzip, LIMITS.mainStylesGzip);
  assertWithin('Lazy Editor JavaScript', editorScript.raw, LIMITS.editorScriptRaw);
  assertWithin('Lazy Editor JavaScript (gzip)', editorScript.gzip, LIMITS.editorScriptGzip);

  return {
    mainScript,
    mainStyles,
    editorScript,
    lazyChunks: REQUIRED_LAZY_CHUNKS.map((prefix) => (
      names.find((name) => name.startsWith(prefix) && name.endsWith('.js'))
    )),
    limits: LIMITS,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectVisualReleaseBuild();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
