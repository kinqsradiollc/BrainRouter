#!/usr/bin/env node

/**
 * BrainRouter MCP Setup
 *
 * Writes MCP config files into a target project folder.
 * You then manually paste the relevant one into your AI tool.
 *
 * Output files (inside <projectRoot>/.brainrouter/):
 *   mcp.cursor.json      → paste into Cursor's MCP config
 *   mcp.vscode.json      → paste into VS Code / GitHub Copilot
 *   mcp.claude.json      → paste into Claude Desktop config
 *   mcp.antigravity.json → paste into Antigravity mcp_config.json
 *   mcp.codex.json       → paste into OpenAI Codex config
 *   mcp.json             → generic / any other tool
 *
 * Usage:
 *   node scripts/setup-mcp.js /path/to/your/project
 *
 * Or via npm (defaults to the BrainRouter repo root):
 *   npm run setup:mcp
 *   npm run setup:mcp -- /path/to/your/project
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Resolve target project root ─────────────────────────────────────────────
const defaultRoot = path.resolve(__dirname, '..', '..');  // BrainRouter repo root
const projectRoot = path.resolve(process.argv[2] || defaultRoot);

if (!fs.existsSync(projectRoot)) {
  console.error(`❌ Project folder does not exist: ${projectRoot}`);
  process.exit(1);
}

// ─── Resolve BrainRouter dist path ───────────────────────────────────────────
const brainRouterDistPath = path.resolve(__dirname, '..', 'dist', 'index.js');

if (!fs.existsSync(brainRouterDistPath)) {
  console.warn(`⚠️  Build not found at: ${brainRouterDistPath}`);
  console.warn(`   Run 'npm run build' inside the mcp/ directory first.\n`);
}

// ─── Output directory inside the project ─────────────────────────────────────
const outputDir = path.join(projectRoot, '.brainrouter');
fs.mkdirSync(outputDir, { recursive: true });

// ─── Parse optional --port flag ───────────────────────────────────────────────
const portIdx = process.argv.indexOf('--port');
const httpPort = portIdx !== -1 && process.argv[portIdx + 1]
  ? parseInt(process.argv[portIdx + 1], 10)
  : 3747;

// ─── The BrainRouter MCP server entry (stdio) ────────────────────────────────
const brainRouterEntry = {
  command: 'node',
  args: [brainRouterDistPath, '--root', projectRoot],
};

// ─── The BrainRouter MCP server entry (HTTP) ────────────────────────────────
const brainRouterHttpEntry = {
  serverUrl: `http://localhost:${httpPort}/mcp`,
};

// ─── Config templates per tool ────────────────────────────────────────────────
// stdio configs — tool spawns the process via command + args
const stdioConfig = {
  mcpServers: {
    brainrouter: brainRouterEntry,
  },
};

// HTTP config — tool connects to the running HTTP server via serverUrl
const httpConfig = {
  mcpServers: {
    brainrouter: brainRouterHttpEntry,
  },
};

const configs = [
  // stdio (local process)
  { file: 'mcp.cursor.json',       label: '⚡ Cursor',                  hint: 'Paste into ~/.cursor/mcp.json  OR  <project>/.cursor/mcp.json', config: stdioConfig },
  { file: 'mcp.vscode.json',       label: '🐙 VS Code / GitHub Copilot', hint: 'Paste into <project>/.vscode/mcp.json', config: stdioConfig },
  { file: 'mcp.claude.json',       label: '🟣 Claude Desktop',           hint: 'Paste into ~/Library/Application Support/Claude/claude_desktop_config.json', config: stdioConfig },
  { file: 'mcp.antigravity.json',  label: '✨ Antigravity (Gemini)',     hint: 'Paste into ~/.gemini/antigravity/mcp_config.json', config: stdioConfig },
  { file: 'mcp.codex.json',        label: '🤖 OpenAI Codex',            hint: 'Paste into ~/.codex/config.json', config: stdioConfig },
  { file: 'mcp.json',              label: '📄 Generic (stdio)',          hint: 'Any other tool that reads an mcpServers config', config: stdioConfig },
  // HTTP (remote server)
  { file: 'mcp.http.json',         label: '🌐 HTTP / Remote',           hint: `Run 'npm run start:http' first, then paste this. Server: http://localhost:${httpPort}/mcp`, config: httpConfig },
];

// ─── Write all configs ────────────────────────────────────────────────────────
console.log('\n🧠 BrainRouter — MCP Config Generator');
console.log('━'.repeat(56));
console.log(`📁 Target project : ${projectRoot}`);
console.log(`🔧 MCP server     : ${brainRouterDistPath}`);
console.log(`📂 Output folder  : ${outputDir}`);
console.log('━'.repeat(56) + '\n');

for (const { file, label, hint, config } of configs) {
  const outPath = path.join(outputDir, file);
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`  ${label}`);
  console.log(`    📝 ${file}`);
  console.log(`    💡 ${hint}\n`);
}

console.log('━'.repeat(56));
console.log(`✅ All configs written to: .brainrouter/`);
console.log('\n📋 Open each file, review, then paste into your tool.\n');
