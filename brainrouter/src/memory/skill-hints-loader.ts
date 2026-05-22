import { readFileSync, existsSync, readdirSync } from "node:fs";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  memory_hints?: string;
  [key: string]: unknown;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Uses a simple, zero-dependency regex parser that handles the common
 * key: value and key: | (block scalar) patterns used in BrainRouter skills.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return {};

  const yaml = fmMatch[1];
  const result: SkillFrontmatter = {};

  // Parse block scalars (key: |\n  line1\n  line2) and simple key: value lines
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Detect block scalar: "key: |"
    const blockMatch = line.match(/^(\w[\w_-]*):\s*\|(.*)$/);
    if (blockMatch) {
      const key = blockMatch[0].split(":")[0].trim();
      const blockLines: string[] = [];
      i++;
      // Collect indented lines
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].startsWith("\t") || lines[i] === "")) {
        blockLines.push(lines[i].replace(/^  /, "").replace(/^\t/, ""));
        i++;
      }
      result[key] = blockLines.join("\n").trimEnd();
      continue;
    }

    // Simple key: value
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2].trim().replace(/^["']|["']$/g, ""); // strip optional quotes
      result[key] = val;
    }
    i++;
  }

  return result;
}

/**
 * Load memory_hints from a SKILL.md file.
 * Returns null if the file doesn't exist or has no memory_hints field.
 */
export function loadSkillHints(skillMdPath: string): { name: string; hints: string } | null {
  if (!existsSync(skillMdPath)) return null;

  let content: string;
  try {
    content = readFileSync(skillMdPath, "utf-8");
  } catch {
    return null;
  }

  const fm = parseSkillFrontmatter(content);
  if (!fm.memory_hints || typeof fm.memory_hints !== "string" || !fm.memory_hints.trim()) {
    return null;
  }

  const skillName = typeof fm.name === "string" ? fm.name : "";
  return {
    name: skillName,
    hints: fm.memory_hints.trim()
  };
}

/**
 * Scan a directory tree for SKILL.md files that contain memory_hints.
 * Returns an array of { skillDir, name, hints } for each skill found.
 */
export function scanSkillsForHints(rootDir: string): Array<{ skillDir: string; name: string; hints: string; filePath: string }> {
  const results: Array<{ skillDir: string; name: string; hints: string; filePath: string }> = [];

  function walk(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          walk(`${dir}/${entry.name}`);
        } else if (entry.name === "SKILL.md") {
          const filePath = `${dir}/${entry.name}`;
          const loaded = loadSkillHints(filePath);
          if (loaded) {
            results.push({
              skillDir: dir,
              name: loaded.name,
              hints: loaded.hints,
              filePath
            });
          }
        }
      }
    } catch {
      return;
    }
  }

  walk(rootDir);
  return results;
}
