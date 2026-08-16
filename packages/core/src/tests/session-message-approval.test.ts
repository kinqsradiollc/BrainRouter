/**
 * ADR-034 authority regressions: only mutation surfaces that are denied or
 * guaranteed to confirm may admit untrusted peer content automatically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessSessionMessageApproval,
  shouldHoldSessionMessage,
} from '../agent/guards/sessionMessageApproval.js';

test('recipient approval is fail-closed for unknown or auto-mutable surfaces', () => {
  assert.equal(shouldHoldSessionMessage({}), true);
  const assessment = assessSessionMessageApproval({
    workspaceFiles: 'denied',
    shell: 'denied',
    computerUse: 'denied',
    externalWrites: 'confirm',
    remoteTools: 'allow',
  });
  assert.equal(assessment.hold, true);
  assert.deepEqual(assessment.unsafeSurfaces, ['remoteTools']);
});

test('recipient approval auto-applies only when every mutation requires a human or is denied', () => {
  assert.equal(shouldHoldSessionMessage({
    workspaceFiles: 'denied',
    shell: 'confirm',
    computerUse: 'denied',
    externalWrites: 'confirm',
    remoteTools: 'confirm',
  }), false);
});
