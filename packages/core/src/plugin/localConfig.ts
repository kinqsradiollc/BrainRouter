/**
 * PLUGIN-MARKETPLACE P5 — per-plugin PROJECT config (plan §4/P5).
 *
 * A workspace can carry persistent, project-scoped config for an installed
 * plugin at `<ws>/.brainrouter/plugins/<name>.local.md` — a Markdown file with
 * YAML frontmatter + a free-form body. The frontmatter is the machine-readable
 * config a plugin's components read; the body is human notes / prose passed
 * through verbatim. BrainRouter conventions only (never `.claude`).
 *
 * This is INERT: nothing reads a plugin's `.local.md` unless the plugin's
 * components ask for it via `readPluginLocalConfig`. The parser is a small,
 * dependency-free YAML-frontmatter reader (scalars + simple lists / nested maps)
 * — it does NOT pull a full YAML engine, matching how the rest of the codebase
 * parses SKILL.md / agent frontmatter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { workspacePluginsDir } from './paths.js';

/** Path of a plugin's per-project config file: `<ws>/.brainrouter/plugins/<name>.local.md`. */
export function pluginLocalConfigPath(name: string, workspaceRoot: string): string {
  return path.join(workspacePluginsDir(workspaceRoot), `${name.trim()}.local.md`);
}

export interface PluginLocalConfig {
  /** Parsed YAML frontmatter (scalars / lists / nested maps). Empty when none. */
  config: Record<string, unknown>;
  /** The Markdown body after the frontmatter (verbatim, trimmed). */
  body: string;
  /** Absolute path the config was read from. */
  path: string;
  /** True when the file existed on disk (vs a default empty result). */
  exists: boolean;
}

/** Coerce a scalar YAML value: booleans, numbers, quoted/bare strings, null. */
function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return null;
  if (s.toLowerCase() === 'true') return true;
  if (s.toLowerCase() === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

/**
 * Minimal YAML-frontmatter parser: `key: value` scalars, block lists
 * (`  - item`), and one level of nested maps (`key:` then indented `sub: val`).
 * Deliberately small — mirrors the frontmatter shapes SKILL.md / agents use.
 */
export function parseFrontmatterConfig(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    // Top-level key (no leading indent).
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const inlineVal = m[2];
    if (inlineVal.trim() !== '') {
      out[key] = parseScalar(inlineVal);
      i++;
      continue;
    }
    // Block value: look ahead for indented list items or nested keys.
    const list: unknown[] = [];
    const nested: Record<string, unknown> = {};
    let j = i + 1;
    let sawList = false;
    let sawNested = false;
    while (j < lines.length) {
      const next = lines[j];
      const indent = next.match(/^(\s+)\S/);
      if (!next.trim()) { j++; continue; }
      if (!indent) break; // dedent back to top level
      const item = next.trim();
      if (item.startsWith('- ')) {
        sawList = true;
        list.push(parseScalar(item.slice(2)));
      } else {
        const nm = item.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
        if (nm) { sawNested = true; nested[nm[1]] = parseScalar(nm[2]); }
      }
      j++;
    }
    if (sawList) out[key] = list;
    else if (sawNested) out[key] = nested;
    else out[key] = null;
    i = j;
  }
  return out;
}

/** Split a `.local.md` file into its frontmatter YAML + Markdown body. */
export function splitFrontmatter(text: string): { yaml: string; body: string } {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { yaml: '', body: text.trim() };
  return { yaml: m[1], body: (m[2] ?? '').trim() };
}

/**
 * Read a plugin's per-project `.local.md` config for a workspace. Returns an
 * empty (but well-formed) result when the file is absent — a plugin's components
 * can always call this safely. Never throws.
 */
export function readPluginLocalConfig(name: string, workspaceRoot: string): PluginLocalConfig {
  const file = pluginLocalConfigPath(name, workspaceRoot);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { config: {}, body: '', path: file, exists: false };
  }
  const { yaml, body } = splitFrontmatter(text);
  return { config: yaml.trim() ? parseFrontmatterConfig(yaml) : {}, body, path: file, exists: true };
}
