/**
 * MC-B1 — the trigger ingress HTTP listener (node:http, zero dependencies).
 *
 * Routes: `POST /triggers/<provider>/events`. This is a NEW ATTACK SURFACE,
 * so the posture is default-deny at every layer:
 *
 * 1. Nothing listens unless `enabled: true` is passed explicitly
 *    (`cli.triggers.enabled` defaults to false).
 * 2. Unknown paths/providers → 404; non-POST → 405.
 * 3. Signature verification is mandatory and runs FIRST: no configured
 *    secret, or a missing/malformed signature header → 401 before the body
 *    is read; an invalid HMAC (timing-safe compare) → 401.
 * 4. The body read is size-capped (413 + connection drop on overflow).
 * 5. Repo allowlist (default empty = nothing allowed): non-allowlisted
 *    events answer a generic 202 — indistinguishable from a processed-later
 *    delivery, so callers can't probe which repos exist here.
 *
 * Only after all gates pass is the payload persisted (bounded + redacted)
 * and the neutral `TriggerEvent` handed to the injectable sink (MC-B2 wires
 * the GitHub resolver → fleet queue there; the default sink is a no-op).
 */
import http from 'node:http';
import { isRepoAllowed } from './allowlist.js';
import { persistTriggerPayload } from './eventStore.js';
import { getTriggerProvider } from './registry.js';
import type { TriggerEvent, TriggerSink } from './triggerTypes.js';
import { firstHeaderValue } from './triggerTypes.js';

/** Default body cap — webhook payloads are small; anything huge is hostile. */
export const TRIGGER_MAX_BODY_BYTES = 1024 * 1024;

export interface TriggerServerOptions {
  /** Must be EXPLICITLY true — the default-deny master switch. */
  enabled: boolean;
  /** Bind host. Default '127.0.0.1' (loopback). */
  host?: string;
  /** Bind port. Default 8787; 0 = ephemeral (tests). */
  port?: number;
  /** `owner/name` glob allowlist. Default [] = nothing allowed. */
  allowedRepos?: readonly string[];
  /** Workspace whose state root stores raw payloads. ''/absent = no
   *  persistence (events carry `payloadRef: ''`). */
  workspaceRoot?: string;
  /** Per-provider webhook secrets ('' / absent = provider rejects all). */
  secrets?: Record<string, string>;
  /** Downstream consumer of verified + allowlisted events. */
  onEvent?: TriggerSink;
  /** Request body cap in bytes (default `TRIGGER_MAX_BODY_BYTES`). */
  maxBodyBytes?: number;
}

export interface TriggerServerHandle {
  server: http.Server;
  host: string;
  /** The ACTUAL bound port (resolves port 0 to the ephemeral pick). */
  port: number;
  close(): Promise<void>;
}

const ROUTE_RE = /^\/triggers\/([a-z0-9_-]+)\/events\/?$/i;

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Read the request body up to `cap` bytes; null = overflow (caller 413s). */
function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        // Stop consuming; the handler answers 413 and the response's
        // `connection: close` tears the socket down.
        req.removeListener('data', onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The request handler, exposed separately so tests can drive it without
 * binding a fixed port and so a host process could mount it elsewhere.
 */
export function createTriggerRequestHandler(options: TriggerServerOptions): http.RequestListener {
  const maxBody = options.maxBodyBytes ?? TRIGGER_MAX_BODY_BYTES;
  const allowedRepos = options.allowedRepos ?? [];
  return (req, res) => {
    void (async () => {
      const pathOnly = (req.url ?? '').split('?')[0];
      const match = ROUTE_RE.exec(pathOnly);
      if (!match) return sendJson(res, 404, { error: 'not_found' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

      const provider = getTriggerProvider(match[1]);
      if (!provider) return sendJson(res, 404, { error: 'not_found' }); // unknown provider

      // Signature FIRST — fail-closed before the body is even read: no
      // configured secret or no signature header means nothing to verify
      // against, so the delivery is rejected outright.
      const secret = (options.secrets?.[provider.name] ?? '').trim();
      const signatureHeader = firstHeaderValue(req.headers[provider.signatureHeader]);
      if (!secret || !signatureHeader) return sendJson(res, 401, { error: 'unauthorized' });

      const rawBody = await readBody(req, maxBody);
      if (rawBody === null) {
        sendJson(res, 413, { error: 'payload_too_large' });
        res.once('finish', () => req.destroy()); // don't keep draining a hostile stream
        return;
      }
      if (!provider.verifySignature({ headers: req.headers, rawBody, secret })) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }

      // Only signed payloads get parsed.
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'invalid_payload' });
      }

      const normalized = provider.normalize(req.headers, payload);
      if (!normalized) return sendJson(res, 202, { accepted: true }); // nothing actionable

      // Allowlist: dropped events answer EXACTLY like accepted ones so the
      // response never reveals which repos this host works on.
      if (!isRepoAllowed(normalized.repo, allowedRepos)) {
        return sendJson(res, 202, { accepted: true });
      }

      const payloadRef = options.workspaceRoot
        ? persistTriggerPayload(options.workspaceRoot, provider.name, rawBody)
        : '';
      const event: TriggerEvent = {
        provider: provider.name,
        kind: normalized.kind,
        repo: normalized.repo,
        number: normalized.number,
        sender: normalized.sender,
        payloadRef,
        receivedAt: new Date().toISOString(),
      };
      try {
        await options.onEvent?.(event);
      } catch {
        // A sink failure is OUR bug, not the sender's — 500 so well-behaved
        // providers redeliver later.
        return sendJson(res, 500, { error: 'sink_failed' });
      }
      return sendJson(res, 200, { ok: true });
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    });
  };
}

/**
 * Start the ingress listener. Throws when `enabled` is not explicitly true —
 * the caller (CLI `serve --triggers`) surfaces the default-deny message;
 * nothing in BrainRouter ever calls this implicitly.
 */
export function startTriggerServer(options: TriggerServerOptions): Promise<TriggerServerHandle> {
  if (options.enabled !== true) {
    return Promise.reject(new Error(
      'Trigger ingress is disabled (cli.triggers.enabled is false). ' +
      'Set cli.triggers.enabled to true in config.json to opt in.',
    ));
  }
  const host = (options.host ?? '').trim() || '127.0.0.1';
  const port = Number.isInteger(options.port) ? (options.port as number) : 8787;
  const server = http.createServer(createTriggerRequestHandler(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        close: () => new Promise<void>((done, fail) => {
          server.close((err) => (err ? fail(err) : done()));
        }),
      });
    });
  });
}
