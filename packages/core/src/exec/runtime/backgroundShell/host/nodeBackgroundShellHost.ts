import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getStateDir } from '../../../../storage/store.js';
import type {
  BackgroundShellHost,
  BackgroundShellProcess,
} from './contracts.js';

function start(input: {
  id: string;
  command: string;
  cwd: string;
  workspaceRoot: string;
}): BackgroundShellProcess {
  const logDir = path.join(getStateDir(input.workspaceRoot), 'bgshell');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${input.id}.log`);
  const fd = fs.openSync(logPath, 'a');
  let closed = false;
  const closeLog = (): void => {
    if (closed) return;
    closed = true;
    try { fs.closeSync(fd); } catch { /* already closed */ }
  };

  try {
    // A detached process group lets cancellation stop both the shell and every
    // descendant it launched instead of orphaning the real background process.
    const child = spawn('sh', ['-c', input.command], {
      cwd: input.cwd,
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    return {
      pid: child.pid ?? null,
      logPath,
      onExit: (listener) => child.on('exit', listener),
      onError: (listener) => child.on('error', listener),
      closeLog,
    };
  } catch (error) {
    closeLog();
    throw error;
  }
}

export const nodeBackgroundShellHost: BackgroundShellHost = {
  createId: () => `bgsh_${randomUUID().slice(0, 8)}`,
  now: Date.now,
  start,
  readLog: (logPath, fromByte, maxBytes) => {
    const size = fs.statSync(logPath).size;
    if (size <= fromByte) return { size, bytes: new Uint8Array() };
    const length = Math.min(size - fromByte, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, 'r');
    try {
      const bytesRead = fs.readSync(fd, buffer, 0, length, fromByte);
      return { size, bytes: buffer.subarray(0, bytesRead) };
    } finally {
      fs.closeSync(fd);
    }
  },
  killProcessTree: (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  },
  onExit: (listener) => process.once('exit', listener),
};
