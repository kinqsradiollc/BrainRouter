import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhasePlan,
  expandPhaseAgents,
  renderPrompt,
  phaseExecutionOrder,
  hasDependencyCycle,
  countPhaseAgents,
  type PhasePlan,
} from '../orchestration/workflow/phasePlan.js';

// A canonical 2-phase plan: fan out one reviewer per target, then synthesize.
const reviewWidePlan = {
  title: 'review each repo then synthesize',
  phases: [
    {
      id: 'review',
      title: 'Review each target',
      fanOut: {
        over: ['repoA', 'repoB', 'repoC'],
        agent: { role: 'reviewer', prompt: 'Review {{target}} and list findings.', access: 'read' },
      },
      synthesize: 'review-merge',
    },
    {
      id: 'synthesize',
      title: 'Synthesize recommendation',
      agents: [{ role: 'architect', prompt: 'Given these findings: {{input}}, recommend.' }],
      inputFrom: ['review'],
      dependsOn: ['review'],
    },
  ],
};

test('normalizePhasePlan accepts a valid 2-phase fan-out → synthesize plan', () => {
  const { plan, errors } = normalizePhasePlan(reviewWidePlan);
  assert.deepEqual(errors, []);
  assert.ok(plan);
  assert.equal(plan!.phases.length, 2);
  assert.equal(plan!.title, 'review each repo then synthesize');
  // defaults filled
  assert.equal(plan!.phases[1].synthesize, 'none');
  assert.equal(plan!.phases[1].agents![0].access, 'read');
});

test('normalizePhasePlan defaults title to id and access to read', () => {
  const { plan } = normalizePhasePlan({
    phases: [{ id: 'p1', agents: [{ prompt: 'do it' }] }],
  });
  assert.ok(plan);
  assert.equal(plan!.phases[0].title, 'p1');
  assert.equal(plan!.phases[0].agents![0].access, 'read');
  assert.equal('fanOut' in plan!.phases[0], false);
  assert.equal('inputFrom' in plan!.phases[0], false);
  assert.equal('dependsOn' in plan!.phases[0], false);
});

test('normalizePhasePlan rejects non-object / empty phases', () => {
  assert.equal(normalizePhasePlan(null).plan, null);
  assert.equal(normalizePhasePlan('nope').plan, null);
  assert.equal(normalizePhasePlan({ phases: [] }).plan, null);
  assert.equal(normalizePhasePlan({}).plan, null);
});

test('normalizePhasePlan flags missing id and duplicate ids', () => {
  const { plan, errors } = normalizePhasePlan({
    phases: [
      { id: 'dup', agents: [{ prompt: 'a' }] },
      { agents: [{ prompt: 'b' }] }, // missing id
      { id: 'dup', agents: [{ prompt: 'c' }] }, // duplicate
    ],
  });
  assert.equal(plan, null);
  assert.ok(errors.some((e) => e.includes('.id is required')));
  assert.ok(errors.some((e) => e.includes('duplicated')));
});

test('normalizePhasePlan requires exactly one of agents | fanOut', () => {
  const neither = normalizePhasePlan({ phases: [{ id: 'p', title: 'x' }] });
  assert.equal(neither.plan, null);
  assert.ok(neither.errors.some((e) => e.includes('exactly one of')));

  const both = normalizePhasePlan({
    phases: [{ id: 'p', agents: [{ prompt: 'a' }], fanOut: { over: ['x'], agent: { prompt: 'b' } } }],
  });
  assert.equal(both.plan, null);
  assert.ok(both.errors.some((e) => e.includes('exactly one of')));
});

test('normalizePhasePlan validates agent prompt, access, and fanOut.over', () => {
  const { plan, errors } = normalizePhasePlan({
    phases: [
      { id: 'a', agents: [{ access: 'shell' }] }, // missing prompt
      { id: 'b', agents: [{ prompt: 'ok', access: 'superuser' }] }, // bad access
      { id: 'c', fanOut: { over: [], agent: { prompt: 'x' } } }, // empty over
    ],
  });
  assert.equal(plan, null);
  assert.ok(errors.some((e) => e.includes('.prompt is required')));
  assert.ok(errors.some((e) => e.includes('.access must be one of')));
  assert.ok(errors.some((e) => e.includes('fanOut.over must be a non-empty')));
});

test('normalizePhasePlan validates synthesize enum and cross-references', () => {
  const { plan, errors } = normalizePhasePlan({
    phases: [
      { id: 'p1', agents: [{ prompt: 'a' }], synthesize: 'magic' },
      { id: 'p2', agents: [{ prompt: 'b' }], inputFrom: ['ghost'], dependsOn: ['missing'] },
    ],
  });
  assert.equal(plan, null);
  assert.ok(errors.some((e) => e.includes('synthesize must be one of')));
  assert.ok(errors.some((e) => e.includes('inputFrom references unknown phase "ghost"')));
  assert.ok(errors.some((e) => e.includes('dependsOn references unknown phase "missing"')));
});

test('normalizePhasePlan detects dependency cycles', () => {
  const { plan, errors } = normalizePhasePlan({
    phases: [
      { id: 'a', agents: [{ prompt: 'x' }], dependsOn: ['b'] },
      { id: 'b', agents: [{ prompt: 'y' }], dependsOn: ['a'] },
    ],
  });
  assert.equal(plan, null);
  assert.ok(errors.some((e) => e.includes('dependency cycle')));
});

test('expandPhaseAgents expands fanOut one-per-target with {{target}} substituted', () => {
  const { plan } = normalizePhasePlan(reviewWidePlan);
  const agents = expandPhaseAgents(plan!.phases[0]);
  assert.equal(agents.length, 3);
  assert.equal(agents[0].prompt, 'Review repoA and list findings.');
  assert.equal(agents[1].prompt, 'Review repoB and list findings.');
  assert.equal(agents[0].label, 'repoA'); // label defaults to target
  assert.equal(agents[0].role, 'reviewer');
  assert.equal(agents[0].access, 'read');
});

test('expandPhaseAgents returns explicit agents with access defaulted', () => {
  const { plan } = normalizePhasePlan({
    phases: [{ id: 'p', agents: [{ prompt: 'one' }, { prompt: 'two', access: 'write' }] }],
  });
  const agents = expandPhaseAgents(plan!.phases[0]);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].access, 'read');
  assert.equal(agents[1].access, 'write');
});

test('renderPrompt substitutes {{target}} and {{input}}', () => {
  assert.equal(renderPrompt('hi {{target}}', { target: 'X' }), 'hi X');
  assert.equal(renderPrompt('use {{input}} now', { input: 'DATA' }), 'use DATA now');
  assert.equal(
    renderPrompt('{{target}} :: {{input}}', { target: 'T', input: 'I' }),
    'T :: I',
  );
  assert.equal(renderPrompt('no vars', {}), 'no vars');
});

test('phaseExecutionOrder honors dependsOn over declaration order', () => {
  const plan: PhasePlan = {
    phases: [
      { id: 'last', title: 'l', agents: [{ prompt: 'x', access: 'read' }], dependsOn: ['first'] },
      { id: 'first', title: 'f', agents: [{ prompt: 'y', access: 'read' }] },
    ],
  };
  const order = phaseExecutionOrder(plan).map((p) => p.id);
  assert.deepEqual(order, ['first', 'last']);
});

test('phaseExecutionOrder keeps declaration order when no deps', () => {
  const { plan } = normalizePhasePlan(reviewWidePlan);
  assert.deepEqual(phaseExecutionOrder(plan!).map((p) => p.id), ['review', 'synthesize']);
});

test('countPhaseAgents counts fan-out targets or explicit agents', () => {
  const { plan } = normalizePhasePlan(reviewWidePlan);
  assert.equal(countPhaseAgents(plan!.phases[0]), 3); // fanOut over 3
  assert.equal(countPhaseAgents(plan!.phases[1]), 1); // 1 explicit agent
});

test('hasDependencyCycle is false for an acyclic plan', () => {
  const { plan } = normalizePhasePlan(reviewWidePlan);
  assert.equal(hasDependencyCycle(plan!.phases), false);
});
