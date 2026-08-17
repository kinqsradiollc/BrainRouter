// ADR-041 D10 — execution world: port resolution precedence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveExecutionPorts,
  LOCAL_EXECUTION_WORLD,
  type ExecutionWorld,
} from "../runtime/executionWorld.js";
import type { FilesystemPort } from "../agent/fs/filesystemPort.js";
import type { ShellPort } from "../agent/shell/shellPort.js";
import type { SubprocessPort } from "../agent/subprocess/subprocessPort.js";

// Reference-identity sentinels — resolution only chooses, it never calls.
const fsWorld = { marker: "fs-world" } as unknown as FilesystemPort;
const shWorld = { marker: "sh-world" } as unknown as ShellPort;
const spWorld = { marker: "sp-world" } as unknown as SubprocessPort;
const fsExplicit = { marker: "fs-explicit" } as unknown as FilesystemPort;

const world: ExecutionWorld = {
  name: "container",
  filesystem: fsWorld,
  shell: shWorld,
  subprocess: spWorld,
};

test("no world and no explicit ports leaves every field undefined (byte-identical to D3)", () => {
  const resolved = resolveExecutionPorts({});
  assert.equal(resolved.filesystemPort, undefined);
  assert.equal(resolved.shellPort, undefined);
  assert.equal(resolved.subprocessPort, undefined);
});

test("a world supplies all three ports", () => {
  const resolved = resolveExecutionPorts({ executionWorld: world });
  assert.equal(resolved.filesystemPort, fsWorld);
  assert.equal(resolved.shellPort, shWorld);
  assert.equal(resolved.subprocessPort, spWorld);
});

test("an explicit per-port option wins over the world, per port", () => {
  const resolved = resolveExecutionPorts({ executionWorld: world, filesystemPort: fsExplicit });
  assert.equal(resolved.filesystemPort, fsExplicit, "explicit filesystem overrides the world");
  assert.equal(resolved.shellPort, shWorld, "shell still comes from the world");
  assert.equal(resolved.subprocessPort, spWorld, "subprocess still comes from the world");
});

test("explicit ports resolve with no world", () => {
  const resolved = resolveExecutionPorts({ filesystemPort: fsExplicit });
  assert.equal(resolved.filesystemPort, fsExplicit);
  assert.equal(resolved.shellPort, undefined);
  assert.equal(resolved.subprocessPort, undefined);
});

test("the default world is named 'local'", () => {
  assert.equal(LOCAL_EXECUTION_WORLD, "local");
});
