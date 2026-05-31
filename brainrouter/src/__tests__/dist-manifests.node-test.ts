import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// dist/__tests__/<this>.js → package root is two levels up.
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(pkgRoot, rel), "utf-8"));

test("DIST-1 server.json: valid registry manifest, in sync with package.json", () => {
  const pkg = readJson("package.json");
  const server = readJson("server.json");

  assert.ok(typeof server.name === "string" && server.name.includes("brainrouter"), "has a registry name");
  assert.equal(server.version, pkg.version, "server.json version tracks package.json (bump both together)");
  assert.ok(Array.isArray(server.packages) && server.packages.length >= 1, "declares a package");

  const npmPkg = server.packages.find((p: any) => p.registryType === "npm");
  assert.ok(npmPkg, "has an npm package entry");
  assert.equal(npmPkg.identifier, pkg.name, "npm identifier matches the published package name");
  assert.equal(npmPkg.version, pkg.version, "npm package version tracks package.json");
  assert.equal(npmPkg.transport?.type, "stdio", "stdio transport");
});

test("DIST-1 .claude-plugin: plugin manifest + bundled mcp config are well-formed", () => {
  const pkg = readJson("package.json");
  const plugin = readJson("../.claude-plugin/plugin.json");
  assert.equal(plugin.name, "brainrouter");
  assert.equal(plugin.version, pkg.version, "plugin version tracks the mcp-server version");
  assert.ok(typeof plugin.description === "string" && plugin.description.length > 0);

  // `.mcp.json` matches the repo's global gitignore rule (machine-specific MCP
  // configs), so it must be force-added (`git add -f`) to ship with the plugin.
  // A clear message beats a cryptic ENOENT when that's forgotten (the CI break
  // that prompted this guard).
  const mcpPath = path.join(pkgRoot, "../.claude-plugin/.mcp.json");
  assert.ok(existsSync(mcpPath), "missing .claude-plugin/.mcp.json — it's gitignored by the global `.mcp.json` rule; commit it with `git add -f`");
  const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
  assert.ok(mcp.mcpServers?.brainrouter, "bundles the brainrouter MCP server");
  const args = mcp.mcpServers.brainrouter.args ?? [];
  assert.ok(args.some((a: string) => a.includes("@kinqs/brainrouter-mcp-server")), "launches the published package");
});
