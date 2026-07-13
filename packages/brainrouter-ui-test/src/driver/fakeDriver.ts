/**
 * A test double for the Playwright driver — speaks the exact same stdio
 * line-protocol but needs no browser, so `DriverClient` can be unit-tested for
 * process lifecycle + request/response correlation. Special testIDs drive the
 * edge cases: `__error__` (transport error), `__hang__` (never replies →
 * timeout), `__malformed__` (a schema-invalid result).
 */
import { encodeLine, LineDecoder } from './protocol.js';

const write = (obj: unknown) => process.stdout.write(encodeLine(obj));

write({ reqId: 'ready' });

const decoder = new LineDecoder();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const msg of decoder.push(chunk)) {
    const req = msg as { reqId?: string; cmd?: { kind: string; testID?: string; screen?: string } };
    if (!req?.reqId || !req.cmd) continue;
    const cmd = req.cmd;
    if (cmd.kind === 'shutdown') {
      write({ reqId: req.reqId, result: { ok: true, status: 'ok', command: 'shutdown', durationMs: 0 } });
      process.exit(0);
      return;
    }
    if (cmd.testID === '__hang__') continue; // never reply
    if (cmd.testID === '__error__') {
      write({ reqId: req.reqId, error: 'boom' });
      continue;
    }
    if (cmd.testID === '__malformed__') {
      write({ reqId: req.reqId, result: { ok: 'notbool', command: cmd.kind } });
      continue;
    }
    write({
      reqId: req.reqId,
      result: {
        ok: true,
        status: 'ok',
        command: cmd.kind,
        testID: cmd.testID,
        screen: cmd.screen,
        durationMs: 1,
        artifacts: { screenshots: [], videos: [], logs: [], other: [] },
      },
    });
  }
});
