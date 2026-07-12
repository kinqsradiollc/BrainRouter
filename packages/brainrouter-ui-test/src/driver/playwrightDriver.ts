/**
 * Layer 5a — the persistent HEADED Chromium driver, run as its own Node process
 * (spawned by `DriverClient`). It lazily `createRequire('playwright')` (an
 * optional peer — never a forced ~300 MB dep) so a workspace without Playwright
 * gets an actionable error instead of a crash. It launches ONE headed browser +
 * page, then serves commands over the stdio line-protocol: read `{reqId, cmd}`,
 * resolve `testID → [data-testid="…"]`, act, capture a screenshot (path only) +
 * the accessibility snapshot, and reply `{reqId, result}`.
 *
 * Only `buildSelector` / the result shaping are imported by tests; the Playwright
 * calls are exercised by the manual E2E (a real browser).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { encodeLine, LineDecoder } from './protocol.js';
import type { Command, UiCommandResult } from '../types.js';

/** Escape a testID for safe insertion into a CSS attribute selector. */
export function cssEscapeAttr(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}

/** `testID → [data-testid="…"]`. */
export function buildSelector(testID: string): string {
  return `[data-testid="${cssEscapeAttr(testID)}"]`;
}

function loadPlaywright(): any | null {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return null;
  }
}

interface DriverCtx {
  baseUrl: string;
  artifactsDir: string;
  timeoutMs: number;
  counter: () => number;
}

function safeName(s: string): string {
  return s.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
}

async function capture(page: any, ctx: DriverCtx, cmd: Command): Promise<string | undefined> {
  try {
    fs.mkdirSync(ctx.artifactsDir, { recursive: true });
    const file = path.join(ctx.artifactsDir, `${ctx.counter()}-${safeName(cmd.kind)}.png`);
    await page.screenshot({ path: file });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort accessibility snapshot for the agent. Tolerant of Playwright API
 * changes: the legacy `page.accessibility.snapshot()` was removed in recent
 * versions, so prefer the modern `locator.ariaSnapshot()` (a compact ARIA tree)
 * and fall back to the legacy API, else undefined — never fail the command.
 */
async function captureA11y(page: any): Promise<unknown> {
  try {
    return await page.locator('body').ariaSnapshot();
  } catch {
    try {
      return await page.accessibility.snapshot();
    } catch {
      return undefined;
    }
  }
}

/** Run one command against the live page and shape a (raw) UiCommandResult. */
async function runCommand(page: any, cmd: Command, ctx: DriverCtx, started: number): Promise<UiCommandResult> {
  const opts = { timeout: ctx.timeoutMs };
  let value: unknown;
  try {
    switch (cmd.kind) {
      case 'navigate': {
        // A relative path (e.g. "/login") needs a base to resolve against. Guard
        // it here so the user gets an actionable message instead of `new URL`'s
        // generic "Invalid URL" when the dev-server base hasn't been set yet.
        const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cmd.url ?? '');
        if (cmd.url && !isAbsolute && !ctx.baseUrl) {
          throw new Error('navigate: a relative path needs a base dev-server URL — set the app URL in the Browser panel first');
        }
        const target = cmd.url ? new URL(cmd.url, ctx.baseUrl || undefined).toString() : ctx.baseUrl;
        if (!target) throw new Error('navigate: no URL and no base dev-server URL set');
        await page.goto(target, { waitUntil: 'load', timeout: ctx.timeoutMs });
        value = target;
        break;
      }
      case 'tap':
        await page.locator(buildSelector(cmd.testID)).first().click(opts);
        break;
      case 'type':
        await page.locator(buildSelector(cmd.testID)).first().fill(cmd.text, opts);
        value = cmd.text;
        break;
      case 'assertVisible':
        await page.locator(buildSelector(cmd.testID)).first().waitFor({ state: 'visible', timeout: ctx.timeoutMs });
        break;
      case 'setDevice':
        await page.setViewportSize({ width: cmd.device.width, height: cmd.device.height });
        value = cmd.device.name;
        break;
      case 'shutdown':
        return { ok: true, status: 'ok', command: 'shutdown', durationMs: 0 };
    }
    const screenshot = await capture(page, ctx, cmd);
    const a11y = await captureA11y(page);
    return {
      ok: true,
      status: 'ok',
      command: cmd.kind,
      testID: (cmd as { testID?: string }).testID,
      screen: (cmd as { screen?: string }).screen,
      value,
      durationMs: Date.now() - started,
      screenshot,
      a11y,
      artifacts: { screenshots: screenshot ? [screenshot] : [], videos: [], logs: [], other: [] },
    };
  } catch (err) {
    const screenshot = await capture(page, ctx, cmd).catch(() => undefined);
    return {
      ok: false,
      status: 'fail',
      command: cmd.kind,
      testID: (cmd as { testID?: string }).testID,
      screen: (cmd as { screen?: string }).screen,
      durationMs: Date.now() - started,
      screenshot,
      error: err instanceof Error ? err.message : String(err),
      artifacts: { screenshots: screenshot ? [screenshot] : [], videos: [], logs: [], other: [] },
    };
  }
}

async function main(): Promise<void> {
  const write = (obj: unknown) => process.stdout.write(encodeLine(obj));
  const pw = loadPlaywright();
  if (!pw) {
    write({ reqId: 'ready', error: 'playwright not installed — run `npx playwright install chromium` and `npm i -D playwright`' });
    process.exit(1);
    return;
  }

  const baseUrl = process.env.UITEST_BASE_URL || '';
  const headed = process.env.UITEST_HEADED !== '0';
  const cwd = process.env.UITEST_CWD || process.cwd();
  let seq = 0;
  const ctx: DriverCtx = {
    baseUrl,
    artifactsDir: path.join(cwd, '.brainrouter', 'ui-tests', 'artifacts'),
    timeoutMs: Number(process.env.UITEST_TIMEOUT_MS || '15000'),
    counter: () => ++seq,
  };

  let browser: any;
  let page: any;
  try {
    browser = await pw.chromium.launch({ headless: !headed });
    const context = await browser.newContext();
    page = await context.newPage();
    if (baseUrl) {
      try {
        await page.goto(baseUrl, { waitUntil: 'load', timeout: ctx.timeoutMs });
      } catch {
        // A missing dev server isn't fatal to startup — commands report it.
      }
    }
    write({ reqId: 'ready' });
  } catch (err) {
    write({ reqId: 'ready', error: `failed to launch chromium: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
    return;
  }

  const shutdown = async (code: number) => {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  const decoder = new LineDecoder();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const msg of decoder.push(chunk)) {
      const req = msg as { reqId?: string; cmd?: Command };
      if (!req?.reqId || !req.cmd) continue;
      if (req.cmd.kind === 'shutdown') {
        write({ reqId: req.reqId, result: { ok: true, status: 'ok', command: 'shutdown', durationMs: 0 } });
        void shutdown(0);
        return;
      }
      const started = Date.now();
      void runCommand(page, req.cmd, ctx, started).then((result) => write({ reqId: req.reqId, result }));
    }
  });
  process.stdin.on('end', () => void shutdown(0));
}

// Only run the loop when executed as a script (not when imported by a test).
const isMain = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = new URL(import.meta.url).pathname;
    const selfPath = process.platform === 'win32' ? self.replace(/^\//, '').replace(/\//g, path.sep) : self;
    return invoked && path.resolve(selfPath) === invoked;
  } catch {
    return false;
  }
})();

if (isMain) {
  void main();
}
