/**
 * Purpose: Prove the supported router compatibility surface resolves to the
 * canonical provider-owned implementations without creating a second engine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as providerSurface from '../provider/index.js';
import * as routerSurface from './index.js';
import * as routerGatewaySurface from './gateway.js';

const COMPATIBILITY_EXPORTS = [
  'aggregateCatalog',
  'buildModelRegistry',
  'resolveRoutes',
  'classifyRouterFailure',
  'getRouterPolicy',
  'validateUpstreamTarget',
  'createPinnedLookup',
  'applyModelEffortWireMap',
  'executeWithProviderRecovery',
] as const;

test('router compatibility exports are identical to the provider-owned implementations', () => {
  for (const name of COMPATIBILITY_EXPORTS) {
    assert.equal(routerSurface[name], providerSurface[name], name);
  }
  assert.equal(routerGatewaySurface.startRouterGateway, providerSurface.startRouterGateway);
  assert.equal(routerGatewaySurface.createRouterGatewayHandler, providerSurface.createRouterGatewayHandler);
});
