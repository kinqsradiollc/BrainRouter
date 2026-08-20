/**
 * ADR-043 D4 — a subtle transparency indicator. A small green status dot appears
 * in the window chrome ONLY while this device is actively holding an egress
 * control channel to the gateway (i.e. it can relay provider traffic through the
 * user's own network). Self-contained: it polls the host `egress-tunnel-status`
 * query and renders NOTHING when inactive (the default), so nothing shows unless
 * the tunnel is enabled + the device enrolled + the control channel connected.
 */
import React from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

export function EgressTunnelBadge(): React.ReactElement | null {
  const [active, setActive] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void bridgeQuery<{ active?: boolean }>('egress-tunnel-status', {}, 5_000)
        .then((r) => {
          if (alive) setActive(!!r?.active);
        })
        .catch(() => {
          if (alive) setActive(false);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  if (!active) return null;
  return (
    <span
      className="status-dot status-dot--ok"
      role="status"
      title="Provider traffic is routing through this device (edge egress)"
      aria-label="Edge egress active — provider traffic is routing through this device"
    />
  );
}
