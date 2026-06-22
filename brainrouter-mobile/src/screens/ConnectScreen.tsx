/**
 * ConnectScreen (S-01) — pairing / host connection. M0 placeholder: the app
 * boots straight into the tabs against the MockTransport, so this is the seam
 * where M1 adds pairing (exchange a code for a device token) and the
 * RemoteTransport (WebSocket) connection lifecycle.
 */
import React from 'react';
import { Screen, EmptyState } from '../components/primitives/Screen';

export function ConnectScreen(): React.JSX.Element {
  return (
    <Screen title="Connect a host">
      <EmptyState
        title="Pairing lands in Milestone 1 (S-01)"
        detail="M0 runs against an in-memory MockTransport so the UI builds without a live brainrouter-host."
      />
    </Screen>
  );
}
