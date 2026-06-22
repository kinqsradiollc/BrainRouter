/**
 * REFAC-TOOLS-MODULE (0.4.6) — tool-name normalization (case/separator/alias
 * resolution), extracted verbatim from agent.ts. No behavior change.
 */
/**
 * Cross-vendor tool-name aliases. Models trained on Claude Code's tool
 * vocabulary often emit `Bash` / `bash` when they want to run a shell command;
 * BrainRouter's canonical name is `run_command`. Rather than rename the tool
 * (breaking transcripts and prompts), normalize the alias at dispatch time.
 *
 * Keep this list short: every alias is a hint the LLM doesn't read its own
 * tool list before calling. Aliases for read_file / write_file / etc. could
 * follow if observed empirically.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: 'run_command',
  shell: 'run_command',
  sh: 'run_command',
};

/**
 * Normalize a tool name the LLM emitted into the canonical form used by the
 * tool registry. Handles common variants: case (`Read_File`), separators
 * (`read-file`, `read.file`), surrounding whitespace, and a short list of
 * cross-vendor aliases (`Bash` → `run_command`).
 *
 * Returns the exact canonical name if a unique match is found among the
 * provided candidates; otherwise returns the trimmed input (so the regular
 * dispatch/explainUnknownToolName path still runs).
 */
export function normalizeToolName(raw: string, candidates: string[]): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return trimmed;
  // Exact match short-circuits — keeps the hot path cheap.
  if (candidates.includes(trimmed)) return trimmed;
  const flatten = (s: string) => s.toLowerCase().replace(/[-.\s_]+/g, '');
  const target = flatten(trimmed);
  // Cross-vendor alias resolution: check before generic case/separator
  // matching so `Bash` resolves to `run_command` even though the flattened
  // forms differ. Only honored when the canonical target is actually
  // registered — keeps us from silently rerouting in unexpected configs.
  const aliased = TOOL_NAME_ALIASES[target];
  if (aliased && candidates.includes(aliased)) return aliased;
  const matches = candidates.filter((c) => flatten(c) === target);
  if (matches.length === 1) return matches[0];
  return trimmed;
}
