/**
 * PLUGIN-MARKETPLACE P1 — `plugin init` scaffold. Writes a minimal plugin
 * skeleton (manifest + a starter skill) into a target dir so `/plugin init`
 * gives the user a working starting point. BrainRouter conventions only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE, KEBAB_CASE_RE } from './manifest.js';

export interface ScaffoldResult {
  ok: boolean;
  root?: string;
  files?: string[];
  error?: string;
}

/**
 * Scaffold a plugin skeleton at `targetDir/<name>` (or `targetDir` when it is
 * empty). Refuses to overwrite an existing manifest.
 */
export function scaffoldPlugin(name: string, targetDir: string): ScaffoldResult {
  const clean = name.trim();
  if (!KEBAB_CASE_RE.test(clean)) return { ok: false, error: `plugin name must be kebab-case (got "${name}")` };

  const root = path.resolve(targetDir, clean);
  const manifestFile = path.join(root, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
  if (fs.existsSync(manifestFile)) return { ok: false, error: `a plugin already exists at ${root}` };

  const files: string[] = [];
  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    files.push(full);
  };

  const manifest = {
    name: clean,
    version: '0.1.0',
    description: `${clean} — a BrainRouter plugin`,
    author: { name: '' },
    category: 'development',
    keywords: [],
    compatibility: { brainrouterVersion: '>=0.4.17', agentApiVersion: '1' },
  };
  write(path.join(PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');

  write(
    path.join('skills', 'hello', 'SKILL.md'),
    `---\nname: ${clean}-hello\ndescription: A starter skill contributed by the ${clean} plugin.\n---\n\n# ${clean}: hello\n\nReplace this with your skill instructions.\n`,
  );

  write(
    'README.md',
    `# ${clean}\n\nA BrainRouter plugin.\n\n## Contributes\n\n- \`skills/\` — auto-discovered skills\n- \`agents/\` — agent definitions (\`.md\`)\n- \`commands/\` — slash-command templates (\`.md\`)\n- \`hooks/hooks.json\` — lifecycle hooks\n- \`workflows/\` — workflow definitions\n- \`connectors/\` — connector definitions\n- \`mcp.json\` — MCP servers (use \`\${BRAINROUTER_PLUGIN_ROOT}\` for portable paths)\n\nInstall with \`brainrouter plugin install <path>\` then \`brainrouter plugin enable ${clean}\`.\n`,
  );

  return { ok: true, root, files };
}
