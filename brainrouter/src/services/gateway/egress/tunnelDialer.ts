import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { Agent, type buildConnector } from 'undici';
import type { ValidatedUpstreamTarget } from '@kinqs/brainrouter-core/provider';
import type { EdgeDialer, UpstreamDispatcherHandle } from '../upstreamPolicy.js';
import { dialTargetFromValidated, type EgressTunnelTransport } from './tunnelTransport.js';

export interface TunnelDialerOptions {
  /**
   * TLS overrides merged into the server-side handshake. `ca` defaults to the
   * system roots; a provider may add pinning here (ADR-043 D1). `rejectUnauthorized`
   * is deliberately NOT exposed — it stays true, so a tampered or forged tunnel
   * breaks the TLS record MAC and the request fails closed.
   */
  readonly tls?: Pick<ConnectionOptions, 'ca' | 'checkServerIdentity'>;
}

/**
 * ADR-043 S3 — build the undici connector that terminates TLS on the SERVER over
 * a byte duplex opened through the user's edge (not a socket the server dialed
 * itself). This is the load-bearing half of inverted egress: the client relays
 * ciphertext; the credential travels only inside the TLS session the server owns.
 *
 * Credential-blind invariant enforced here: a non-`https:` target is refused
 * before the edge is ever touched — a plaintext tunnel would expose the
 * credential to the relaying device, which is the exact thing this design exists
 * to prevent (ADR-043 D1, option A rejected).
 */
export function createTunnelConnector(
  transport: EgressTunnelTransport,
  target: ValidatedUpstreamTarget,
  options: TunnelDialerOptions = {},
): buildConnector.connector {
  return (opts, callback) => {
    if (target.url.protocol !== 'https:') {
      callback(
        new Error(
          'Egress tunnel requires https — a plaintext tunnel would expose the credential to the relaying device.',
        ),
        null,
      );
      return;
    }
    transport
      .open(dialTargetFromValidated(target))
      .then((duplex) => {
        const tlsSocket = tlsConnect({
          socket: duplex,
          servername: opts.servername ?? target.hostname,
          ALPNProtocols: ['http/1.1'],
          ...(options.tls ?? {}),
        });
        const detach = (): void => {
          tlsSocket.removeListener('secureConnect', onSecure);
          tlsSocket.removeListener('error', onError);
        };
        const onSecure = (): void => {
          detach();
          callback(null, tlsSocket);
        };
        const onError = (err: Error): void => {
          detach();
          callback(err, null);
        };
        tlsSocket.once('secureConnect', onSecure);
        tlsSocket.once('error', onError);
      })
      .catch((err: unknown) => {
        callback(err instanceof Error ? err : new Error(String(err)), null);
      });
  };
}

/**
 * ADR-043 S3 — the tunnel {@link EdgeDialer}: a drop-in for `directDialer` that
 * routes the upstream connection through `transport` (the user's edge) instead of
 * dialing from the server host. Nothing selects it yet — S4 wires selection off
 * `ProviderDefinition.egressMode` around this same `dispatcherFactory` seam; until
 * then egress is byte-identical (server egress via `directDialer`).
 */
export function createTunnelDialer(
  transport: EgressTunnelTransport,
  options: TunnelDialerOptions = {},
): EdgeDialer {
  return (target: ValidatedUpstreamTarget): UpstreamDispatcherHandle => {
    const dispatcher = new Agent({ connect: createTunnelConnector(transport, target, options) });
    return { dispatcher, close: () => dispatcher.close() };
  };
}
