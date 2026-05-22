import { join, resolve, dirname } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Returns a guaranteed new incremental output directory path for the current date.
 * Creates the directory if it doesn't exist.
 * Format: `brainrouter/benchmark/results/YYYY-MM-DD/{incremental_index}`
 */
export function getIncrementalOutputDir(): string {
  if (process.env.BENCH_OUT_DIR) {
    const resolved = resolve(process.env.BENCH_OUT_DIR);
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }
  const todayStr = new Date().toISOString().split("T")[0];
  const baseDir = resolve(__dirname, "../../benchmark/results", todayStr);
  
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Find the next incremental index
  const dirs = readdirSync(baseDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => parseInt(dirent.name, 10))
    .filter(num => !isNaN(num));

  const nextIndex = dirs.length > 0 ? Math.max(...dirs) + 1 : 1;
  const outDir = join(baseDir, nextIndex.toString());
  
  mkdirSync(outDir, { recursive: true });
  return outDir;
}
