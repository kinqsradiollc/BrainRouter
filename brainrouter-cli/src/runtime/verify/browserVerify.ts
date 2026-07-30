/**
 * VERIFY-BROWSER (0.4.5) — run a configurable browser smoke test and collect
 * its artifacts (screenshots / video / console+network logs).
 *
 * BrainRouter does NOT bundle a browser. Instead `cli.browserSmoke` is a shell
 * command template the user wires to their own harness (Playwright, puppeteer,
 * a Chrome DevTools MCP runner, …). We substitute `{url}` and `{out}`, run it,
 * and classify whatever files it wrote into `{out}`. The pure pieces here
 * (command building + artifact classification) are unit-testable without a
 * browser, a shell, or a filesystem; the command handler injects exec + a
 * directory lister.
 */

export interface BrowserArtifacts {
  screenshots: string[];
  videos: string[];
  logs: string[];
  other: string[];
}

export interface BrowserSmokeResult {
  command: string;
  url: string;
  outDir: string;
  ok: boolean;
  exitCode: number;
  output: string;
  artifacts: BrowserArtifacts;
}

/** Substitute `{url}` / `{out}` (and the `${...}` variants) in the template. */
export function buildBrowserSmokeCommand(template: string, opts: { url: string; outDir: string }): string {
  return template
    .replace(/\$\{url\}|\{url\}/g, opts.url)
    .replace(/\$\{out\}|\{out\}/g, opts.outDir);
}

const SCREENSHOT_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const VIDEO_EXT = new Set(["webm", "mp4", "mov"]);
const LOG_EXT = new Set(["log", "txt", "json", "har", "ndjson", "jsonl"]);

function ext(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Bucket a flat list of produced files by artifact kind. */
export function classifyArtifacts(files: string[]): BrowserArtifacts {
  const out: BrowserArtifacts = { screenshots: [], videos: [], logs: [], other: [] };
  for (const f of files) {
    const e = ext(f);
    if (SCREENSHOT_EXT.has(e)) out.screenshots.push(f);
    else if (VIDEO_EXT.has(e)) out.videos.push(f);
    else if (LOG_EXT.has(e)) out.logs.push(f);
    else out.other.push(f);
  }
  return out;
}

export type ExecFn = (command: string, cwd: string) => { exitCode: number; output: string };
export type ListFn = (dir: string) => string[];

/**
 * Run the browser smoke command and gather artifacts. Returns `{ error }` when
 * the feature is unconfigured. Never throws on a non-zero exit — that's a
 * normal "smoke failed" result the caller reports.
 */
export function runBrowserSmoke(
  template: string,
  opts: { url: string; outDir: string; cwd: string },
  exec: ExecFn,
  list: ListFn,
): BrowserSmokeResult | { error: string } {
  if (!template.trim()) {
    return { error: "Browser smoke not configured. Set cli.browserSmoke to a command template using {url} and {out}." };
  }
  const command = buildBrowserSmokeCommand(template, opts);
  const { exitCode, output } = exec(command, opts.cwd);
  let files: string[] = [];
  try { files = list(opts.outDir); } catch { files = []; }
  return {
    command,
    url: opts.url,
    outDir: opts.outDir,
    ok: exitCode === 0,
    exitCode,
    output,
    artifacts: classifyArtifacts(files),
  };
}

/** Render a smoke result as plain lines (caller colours). */
export function formatBrowserSmokeResult(r: BrowserSmokeResult): string[] {
  const a = r.artifacts;
  const counts = `${a.screenshots.length} screenshot(s), ${a.videos.length} video(s), ${a.logs.length} log(s)`;
  const head = `${r.ok ? "✓" : "✗"} browser smoke: ${r.url} (exit ${r.exitCode}) — ${counts}`;
  const tail = r.output.trim().split("\n").slice(-10).map((l) => `  ${l}`);
  const artifactLines = [...a.screenshots, ...a.videos, ...a.logs].slice(0, 12).map((f) => `  • ${f}`);
  return [head, ...(artifactLines.length ? ["  artifacts:", ...artifactLines] : []), ...(tail.length && tail[0].trim() ? tail : [])];
}
