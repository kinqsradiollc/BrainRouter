#!/usr/bin/env node
/**
 * Single-command version bump for the whole monorepo — the source of truth for
 * "what version is this". Run with the target version as the only argument:
 *
 *   node scripts/set-version.mjs 0.4.21
 *
 * For every package.json (root + workspaces, node_modules excluded) it sets
 * `version` and rewrites every internal `@kinqs/brainrouter-*` dependency range
 * to `^<version>`, preserving formatting. The version is NEVER hardcoded in
 * source — the app reads it from package.json at load (packages/core/version.ts)
 * — so this script + the release workflow's `version` input are the only place a
 * release number lives. Beyond package.json it also syncs the version-bearing
 * manifests CI checks for drift (brainrouter/server.json, .claude-plugin/plugin.json).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const version = (process.argv[2] || "").trim().replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Usage: node scripts/set-version.mjs <version>  (got: ${JSON.stringify(process.argv[2])})`);
  process.exit(1);
}

// Enumerate tracked package.json files (respects .gitignore, skips node_modules).
const files = execSync("git ls-files -- '**/package.json' 'package.json'", { encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean)
  .filter((f) => !f.includes("node_modules/"));

const DEP_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
let changed = 0;
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  let touched = false;
  if (Object.prototype.hasOwnProperty.call(pkg, "version") && pkg.version !== version) {
    pkg.version = version; touched = true;
  }
  for (const key of DEP_KEYS) {
    const deps = pkg[key];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith("@kinqs/brainrouter-")) {
        const next = `^${version}`;
        if (deps[name] !== next && deps[name] !== "*" && !String(deps[name]).startsWith("file:") && !String(deps[name]).startsWith("workspace:")) {
          deps[name] = next; touched = true;
        }
      }
    }
  }
  if (touched) {
    // Preserve trailing newline convention.
    writeFileSync(file, JSON.stringify(pkg, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
    changed++;
    console.log(`set ${version} · ${file}`);
  }
}

// Non-package.json manifests that also carry the release version and are checked
// for drift in CI (brainrouter DIST-1). Kept in lockstep here so a bump is one
// command. Each entry lists the JSON paths whose `version` must track the release.
const EXTRA_MANIFESTS = [
  { file: "brainrouter/server.json", bump: (m) => {
      let t = false;
      if (m.version !== version) { m.version = version; t = true; }
      for (const pkg of m.packages ?? []) {
        if (pkg && typeof pkg === "object" && pkg.version !== version) { pkg.version = version; t = true; }
      }
      return t;
    } },
  { file: ".claude-plugin/plugin.json", bump: (m) => {
      if (m.version !== version) { m.version = version; return true; }
      return false;
    } },
];
let extraChanged = 0;
for (const { file, bump } of EXTRA_MANIFESTS) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { continue; } // absent in some checkouts
  const manifest = JSON.parse(raw);
  if (bump(manifest)) {
    writeFileSync(file, JSON.stringify(manifest, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
    extraChanged++;
    console.log(`set ${version} · ${file}`);
  }
}
if (extraChanged) console.log(`[set-version] ${version} applied to ${extraChanged} extra manifest(s).`);

console.log(`\n[set-version] ${version} applied to ${changed} package.json file(s).`);
