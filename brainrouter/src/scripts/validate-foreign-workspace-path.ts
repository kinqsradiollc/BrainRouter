import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSafeWorkspacePath } from "../resolver.js";
import { getWorkingMemoryDir } from "../memory/working/offload.js";
import { handleMemoryResolveSession } from "../tools/memory_resolve_session.js";

const foreignWorkspacePath = process.argv[2] ?? "c:\\Users\\Miu\\Desktop\\Tung\\review paper 1";
const pollutedPath = path.resolve(foreignWorkspacePath);
const safeWorkspacePath = getSafeWorkspacePath(foreignWorkspacePath);
const sessionKey = "foreign-path-validation";
const userId = "validation-user";

function parseToolJson(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

fs.rmSync(pollutedPath, { recursive: true, force: true });
fs.rmSync(safeWorkspacePath, { recursive: true, force: true });

const resolvedSession = parseToolJson(await handleMemoryResolveSession({
  workspacePath: foreignWorkspacePath,
}));
const workDir = getWorkingMemoryDir(foreignWorkspacePath, userId, sessionKey);
fs.mkdirSync(workDir, { recursive: true });

const pollutedExists = fs.existsSync(pollutedPath);
const safeCacheExists = fs.existsSync(path.join(safeWorkspacePath, ".brainrouter", "active_session.json"));
const workDirExists = fs.existsSync(workDir);

console.log(JSON.stringify({
  foreignWorkspacePath,
  safeWorkspacePath,
  expectedFallbackRoot: path.join(os.homedir(), ".brainrouter"),
  resolvedSession,
  workDir,
  pollutedPath,
  pollutedExists,
  safeCacheExists,
  workDirExists,
  ok: !pollutedExists && safeCacheExists && workDirExists,
}, null, 2));

if (pollutedExists || !safeCacheExists || !workDirExists) {
  process.exitCode = 1;
}
