import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { isPortFree, findFreePort } from './portUtil.js';

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
function close(srv: net.Server): Promise<void> {
  return new Promise((r) => srv.close(() => r()));
}

test('isPortFree is true for a free port and false for a bound one', async () => {
  const port = await findFreePort(49200);
  assert.ok(port, 'found a free port to test with');
  assert.equal(await isPortFree(port!), true);
  const srv = await listen(port!);
  try {
    assert.equal(await isPortFree(port!), false, 'a bound port is not free');
  } finally {
    await close(srv);
  }
});

test('findFreePort skips a bound port and returns a later free one', async () => {
  const base = await findFreePort(49300);
  assert.ok(base);
  const srv = await listen(base!);
  try {
    const next = await findFreePort(base!);
    assert.ok(next && next > base!, `moved past the bound port ${base} -> ${next}`);
  } finally {
    await close(srv);
  }
});
