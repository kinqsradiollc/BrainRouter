/**
 * A25-8c — port-backed finding reconciliation fixture.
 *
 * The host applies transitions idempotently; Core never turns an incomplete
 * absence into a fixed finding.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAssuranceFindingLifecycleService,
  findingFingerprint,
  type AssuranceFindingLifecyclePort,
  type AssuranceLifecycleScope,
  type LifecycleCurrentFinding,
  type LifecycleTransition,
} from '../review/index.js';

const scope: AssuranceLifecycleScope = {
  organizationId: 'org-1',
  repository: 'owner/repository',
  program: 'security_review',
};

function current(): LifecycleCurrentFinding {
  const source = {
    file: 'src/handler.ts',
    severity: 'high',
    title: '[CWE-79] Unsanitized input reaches HTML output',
    cwe: 'CWE-79',
  };
  return {
    id: 'finding-1',
    fingerprint: findingFingerprint(scope.program, source),
    file: source.file,
    title: source.title,
    cwe: source.cwe,
    status: 'open',
  };
}

class InMemoryLifecyclePort implements AssuranceFindingLifecyclePort {
  readonly applied = new Map<string, LifecycleTransition>();
  constructor(readonly rows: LifecycleCurrentFinding[]) {}

  async listCurrent(): Promise<LifecycleCurrentFinding[]> {
    return structuredClone(this.rows);
  }

  async apply(_scope: AssuranceLifecycleScope, transitions: LifecycleTransition[]): Promise<void> {
    for (const transition of transitions) {
      const key = [transition.type, transition.findingId ?? '', transition.fingerprint].join('\0');
      if (!this.applied.has(key)) this.applied.set(key, structuredClone(transition));
    }
  }
}

test('A25-8c lifecycle port applies retries idempotently', async () => {
  const port = new InMemoryLifecyclePort([]);
  const service = createAssuranceFindingLifecycleService(port);
  const input = {
    scope,
    incoming: [{
      file: 'src/handler.ts',
      severity: 'high',
      title: '[CWE-79] Unsanitized input reaches HTML output',
      cwe: 'CWE-79',
    }],
    complete: true,
  };
  await service.reconcile(input);
  await service.reconcile(input);
  assert.equal(port.applied.size, 1);
});

test('A25-8c incomplete lifecycle evidence never fixes an absent finding', async () => {
  const port = new InMemoryLifecyclePort([current()]);
  const service = createAssuranceFindingLifecycleService(port);
  assert.deepEqual(await service.reconcile({ scope, incoming: [], complete: false }), []);
  assert.equal(port.applied.size, 0);
  assert.deepEqual(
    (await service.reconcile({ scope, incoming: [], complete: true }))
      .map((transition) => transition.type),
    ['fixed'],
  );
});
