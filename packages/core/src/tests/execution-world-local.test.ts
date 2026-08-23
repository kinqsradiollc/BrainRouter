// ADR-041 A41-10 — the concrete `local` execution world binds the node ports, and
// making it the default is byte-identical to the pre-D10 call-site fall-throughs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localExecutionWorld as getLocalExecutionWorld, LOCAL_EXECUTION_WORLD_NAME } from '../runtime/localWorld.js';

const localExecutionWorld = getLocalExecutionWorld();
import { resolveExecutionPorts } from '../runtime/executionWorld.js';
import { nodeFilesystemPort } from '../agent/fs/filesystemPort.js';
import { defaultSubprocessPort } from '../agent/subprocess/externalCliSubprocess.js';
import { runShell } from '../exec/runtime/sandbox.js';
import { startBackgroundShell } from '../exec/runtime/backgroundShell.js';
import { runtimeCompositionSnapshot } from '../runtime/compositionSnapshot.js';

test('A41-10 — the local world binds the exact node port implementations', () => {
  assert.equal(localExecutionWorld.name, LOCAL_EXECUTION_WORLD_NAME);
  assert.equal(localExecutionWorld.filesystem, nodeFilesystemPort, 'filesystem is the identical node port');
  assert.equal(localExecutionWorld.subprocess, defaultSubprocessPort, 'subprocess is the identical node port');
  // Shell is rebuilt from the same two exported leaves the handler's nodeShellPort uses.
  assert.equal(localExecutionWorld.shell.runShell, runShell, 'shell.runShell is the identical function');
  assert.equal(localExecutionWorld.shell.startBackgroundShell, startBackgroundShell, 'shell.startBackgroundShell is the identical function');
});

test('A41-10 — resolving ports through the local world yields the node defaults (byte-identical)', () => {
  const resolved = resolveExecutionPorts({ executionWorld: localExecutionWorld });
  assert.equal(resolved.filesystemPort, nodeFilesystemPort, 'the call site `?? nodeFilesystemPort` gets the same object');
  assert.equal(resolved.subprocessPort, defaultSubprocessPort);
  assert.equal(resolved.shellPort!.runShell, runShell, 'the call site `?? nodeShellPort` calls the same runShell');
});

test('A41-10 — an explicit per-port option still overrides the local world', () => {
  const fsExplicit = { ...nodeFilesystemPort } as typeof nodeFilesystemPort;
  const resolved = resolveExecutionPorts({ filesystemPort: fsExplicit, executionWorld: localExecutionWorld });
  assert.equal(resolved.filesystemPort, fsExplicit, 'explicit filesystem wins');
  assert.equal(resolved.subprocessPort, defaultSubprocessPort, 'the rest still come from the world');
});

test('A41-10 — the composition dump reports the active execution world', () => {
  assert.equal(runtimeCompositionSnapshot().executionWorld, 'local');
});
