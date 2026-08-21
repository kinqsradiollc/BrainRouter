/**
 * ADR-041 A41-16 (W4) — the out-of-process SDK surface is real and usable.
 *
 * A consumer that only depends on `@kinqs/brainrouter-core/sdk` (here, the local
 * `../sdk/index.js` barrel behind that entry point) must be able to construct a
 * remote runner client and drive an agent over `/runtime/v1` with nothing but a
 * `fetch`. This proves the SDK re-exports the whole client contract, that the
 * `server_info` handshake gates the first call, and that the session header and
 * versioned paths are wired — without standing up a real runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntimeRunnerClient,
  RUNTIME_API_PREFIX,
  RUNTIME_SESSION_HEADER,
  assertRuntimeServerCompatible,
  type RuntimeRunnerClient,
  type CreateRuntimeRunnerClientOptions,
} from '../sdk/index.js';
import { VERSION } from '../version.js';

const BASE = 'https://runtime-host:7171';

/** A fetch that records every request and answers the runtime protocol. */
function recordingFetch() {
  const calls: Array<{ url: string; method: string; sessionKey: string | null; body: unknown }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, sessionKey: headers.get(RUNTIME_SESSION_HEADER), body });

    if (url.endsWith(`${RUNTIME_API_PREFIX}/server_info`)) {
      // Same major.minor as the client, so the compatibility gate passes.
      return Response.json({ protocol: 'runtime/v1', version: VERSION });
    }
    if (url.endsWith(`${RUNTIME_API_PREFIX}/start`)) {
      return Response.json({ runtimeId: 'rt-1', status: 'ready', kind: 'process' });
    }
    if (url.endsWith(`${RUNTIME_API_PREFIX}/send`)) {
      return Response.json({ runtimeId: 'rt-1', output: `echo:${body?.prompt ?? ''}` });
    }
    return Response.json({ error: `unexpected ${method} ${url}` }, { status: 500 });
  };
  return { calls, fetchImpl };
}

function remoteClient(fetchImpl: CreateRuntimeRunnerClientOptions['fetch']): RuntimeRunnerClient {
  return createRuntimeRunnerClient({
    workspaceRoot: '/tmp/unused-in-remote-mode',
    remoteUrl: BASE,
    fetch: fetchImpl,
    // Required by the options type; never invoked when remoteUrl is set.
    executeTurn: async () => '',
  });
}

test('A41-16 — the SDK entry point drives a remote runtime with only a fetch', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = remoteClient(fetchImpl);
  assert.equal(client.mode, 'remote');

  const started = await client.start({ sessionKey: 'sess-abc' });
  assert.deepEqual(started, { runtimeId: 'rt-1', status: 'ready', kind: 'process' });

  const sent = await client.send({ runtimeId: started.runtimeId, sessionKey: 'sess-abc', prompt: 'hello' });
  assert.equal(sent.output, 'echo:hello');

  // The compatibility handshake fired once, before the first real call, and is
  // not repeated on the second.
  const infoCalls = calls.filter((c) => c.url.endsWith('/server_info'));
  assert.equal(infoCalls.length, 1, 'server_info handshake runs exactly once');

  // start + send both carried the session header on the versioned path.
  const post = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(post.map((c) => c.url), [`${BASE}${RUNTIME_API_PREFIX}/start`, `${BASE}${RUNTIME_API_PREFIX}/send`]);
  for (const c of post) assert.equal(c.sessionKey, 'sess-abc', 'session key travels in the runtime header');
});

test('A41-16 — a version-mismatched runtime is refused before any turn runs', async () => {
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(`${RUNTIME_API_PREFIX}/server_info`)) {
      return Response.json({ protocol: 'runtime/v1', version: '0.0.1' });
    }
    return Response.json({ error: 'should never be reached' }, { status: 500 });
  };
  // The re-exported guard is the same one the client uses internally.
  await assert.rejects(
    () => assertRuntimeServerCompatible(BASE, { fetch: fetchImpl }),
    /version mismatch/,
  );
  await assert.rejects(
    () => remoteClient(fetchImpl).start({ sessionKey: 'sess-x' }),
    /version mismatch/,
    'start refuses an incompatible runtime rather than sending the turn',
  );
});
