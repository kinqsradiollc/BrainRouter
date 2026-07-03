/**
 * Atlas — workspace scanner (ATLAS-2)
 *
 * Deterministic first stage of the Atlas pipeline: walk the workspace
 * (ignore-aware via `git ls-files`, with a plain-fs fallback), classify each
 * file by language + category, count lines, and read light project metadata.
 * No LLM, no network — just the file inventory the graph builder works from.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AtlasFileCategory } from "@kinqs/brainrouter-types";
import { fileExtension } from "../../util/autoReindex.js";

export interface ScannedFile {
  /** Workspace-relative POSIX path. */
  path: string;
  /** Language id, e.g. `typescript` (or the bare extension / `text`). */
  language: string;
  category: AtlasFileCategory;
  sizeLines: number;
}

export interface ScanResult {
  name: string;
  description?: string;
  /** Code languages, most-files-first. */
  languages: string[];
  frameworks: string[];
  files: ScannedFile[];
  totalFiles: number;
}

export interface ScanOptions {
  /** Cap on files scanned (code files prioritized). Default 4000. */
  maxFiles?: number;
  /** Skip files larger than this many bytes. Default 1.5 MB. */
  maxFileBytes?: number;
}

/** Extension → language id. Bare extension is the fallback. */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", go: "go", rs: "rust", java: "java", kt: "kotlin",
  rb: "ruby", php: "php", swift: "swift", scala: "scala", dart: "dart",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", m: "objc", mm: "objc", lua: "lua", r: "r", ex: "elixir", exs: "elixir",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", bat: "batch",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  xml: "xml", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  md: "markdown", mdx: "markdown", rst: "restructuredtext", txt: "text",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  tf: "terraform", hcl: "hcl", dockerfile: "dockerfile", vue: "vue", svelte: "svelte",
};

const DOCS_EXT = new Set(["md", "mdx", "rst", "txt", "adoc"]);
const DATA_EXT = new Set(["sql", "graphql", "gql", "proto", "prisma", "csv", "tsv"]);
const SCRIPT_EXT = new Set(["sh", "bash", "zsh", "ps1", "bat"]);
const MARKUP_EXT = new Set(["html", "htm", "css", "scss", "less", "xml", "svg"]);
const CONFIG_EXT = new Set(["json", "jsonc", "yaml", "yml", "toml", "ini", "env", "properties", "cfg", "conf"]);
const CODE_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "go", "rs",
  "java", "kt", "rb", "php", "swift", "scala", "dart", "c", "h", "cpp", "cc", "cxx",
  "hpp", "hh", "cs", "m", "mm", "lua", "r", "ex", "exs", "vue", "svelte",
]);

/** Directory/path fragments that are always ignored even if `git` lists them. */
const IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", "coverage",
  ".git", ".venv", "venv", "vendor", "target", "__pycache__", ".turbo",
  ".cache", ".parcel-cache", "dist-electron", ".understand-anything",
]);

function categorize(relPath: string, ext: string): AtlasFileCategory {
  const base = path.basename(relPath).toLowerCase();
  const lower = relPath.toLowerCase();
  if (base === "dockerfile" || base === "jenkinsfile" || ext === "tf" || ext === "hcl" ||
      lower.includes(".github/workflows/") || lower.startsWith("k8s/") || lower.includes("/k8s/")) return "infra";
  if (base === "makefile" || SCRIPT_EXT.has(ext)) return "script";
  if (DATA_EXT.has(ext)) return "data";
  if (MARKUP_EXT.has(ext)) return "markup";
  if (DOCS_EXT.has(ext) && base !== "license") return "docs";
  if (CONFIG_EXT.has(ext) || base === ".env" || base.endsWith(".config")) return "config";
  if (CODE_EXT.has(ext)) return "code";
  return base === "license" ? "docs" : "config";
}

/** List workspace files, ignore-aware. Tries git first, falls back to an fs walk. */
function listFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root, encoding: "utf8", maxBuffer: 96 * 1024 * 1024,
    });
    const files = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (files.length) return files;
  } catch {
    /* not a git repo (or git missing) — fall through to fs walk */
  }
  const acc: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env") continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile()) acc.push(childRel);
      if (acc.length > 50_000) return; // hard safety cap on the fs walk
    }
  };
  walk(root, "");
  return acc;
}

function isIgnored(relPath: string): boolean {
  return relPath.split("/").some((seg) => IGNORE_DIRS.has(seg));
}

function countLines(absPath: string, sizeBytes: number): number {
  try {
    const buf = fs.readFileSync(absPath);
    let n = 1;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
  } catch {
    return Math.max(1, Math.round(sizeBytes / 40));
  }
}

const FRAMEWORK_HINTS: Array<[string, string]> = [
  ["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["svelte", "Svelte"],
  ["express", "Express"], ["fastify", "Fastify"], ["@nestjs/core", "NestJS"],
  ["electron", "Electron"], ["vite", "Vite"], ["django", "Django"], ["flask", "Flask"],
  ["fastapi", "FastAPI"], ["@angular/core", "Angular"], ["tailwindcss", "Tailwind"],
];

function readProjectMeta(root: string, files: ScannedFile[]): { name: string; description?: string; frameworks: string[] } {
  let name = path.basename(root) || "workspace";
  let description: string | undefined;
  const frameworks = new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    if (typeof pkg.name === "string" && pkg.name) name = pkg.name;
    if (typeof pkg.description === "string") description = pkg.description;
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, unknown>;
    for (const [needle, label] of FRAMEWORK_HINTS) if (deps[needle] !== undefined) frameworks.add(label);
  } catch { /* no package.json */ }
  // README first paragraph as a description fallback
  if (!description) {
    const readme = files.find((f) => /^readme\.(md|rst|txt)$/i.test(path.basename(f.path)));
    if (readme) {
      try {
        const txt = fs.readFileSync(path.join(root, readme.path), "utf8");
        const firstPara = txt.split(/\n\s*\n/).map((s) => s.replace(/^#+\s*/, "").trim()).find((s) => s.length > 20);
        if (firstPara) description = firstPara.slice(0, 280);
      } catch { /* ignore */ }
    }
  }
  return { name, description, frameworks: [...frameworks] };
}

/** Scan a workspace into a deterministic file inventory + project metadata. */
export function scanWorkspace(root: string, opts: ScanOptions = {}): ScanResult {
  const maxFiles = opts.maxFiles ?? 4000;
  const maxBytes = opts.maxFileBytes ?? 1_500_000;
  const rels = listFiles(root).filter((p) => !isIgnored(p));

  const scanned: ScannedFile[] = [];
  const langCount = new Map<string, number>();
  for (const rel of rels) {
    const abs = path.join(root, rel);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > maxBytes) continue;
    const ext = fileExtension(rel).toLowerCase();
    const language = EXT_LANG[ext] ?? (ext || "text");
    const category = categorize(rel, ext);
    scanned.push({ path: rel, language, category, sizeLines: countLines(abs, stat.size) });
    if (category === "code") langCount.set(language, (langCount.get(language) ?? 0) + 1);
  }

  // Cap: prefer code files, then everything else, keeping determinism (sorted).
  scanned.sort((a, b) => {
    if (a.category !== b.category) return a.category === "code" ? -1 : b.category === "code" ? 1 : 0;
    return a.path.localeCompare(b.path);
  });
  const files = scanned.slice(0, maxFiles);

  const languages = [...langCount.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const { name, description, frameworks } = readProjectMeta(root, files);
  return { name, description, languages, frameworks, files, totalFiles: files.length };
}
