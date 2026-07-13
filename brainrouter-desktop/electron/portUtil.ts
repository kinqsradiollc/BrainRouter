/**
 * Port helpers for the auto-host flow. Kept dependency-free (only node:net) so
 * they're unit-testable under `node --test` without pulling in electron.
 *
 * Used by ensureApp to move a dev server off a port another process is holding:
 * check whether a port is bindable, and find the next free one.
 */
import net from 'node:net';

/** True when we can bind `port` on 127.0.0.1 (i.e. it's free for our dev server). */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, '127.0.0.1');
    } catch {
      resolve(false);
    }
  });
}

/** The first free port at/after `start` (scans a bounded window), or null if none. */
export async function findFreePort(start: number, span = 50): Promise<number | null> {
  for (let p = start; p < start + span && p <= 65535; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}
