/**
 * ADR-027 D4.1 (P2-6) — the degradation ladder for non-text input.
 *
 * The invariant every case defends: an attachment is NEVER silently dropped.
 * Either the model can read it, or we route to one that can, or we refuse, or
 * we say plainly that we could not verify. What must never happen is an answer
 * about content the model never received, with nothing to indicate it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planForModalities,
  describeModalityPlan,
  type ModalityCandidate,
} from '../provider/modalityPlan.js';

const vision = { input: { status: 'known', accepts: ['image'] } } as const;
const textOnly = { input: { status: 'known', accepts: [] } } as const;
const unknown = { input: { status: 'unknown' } } as const;
const multimodal = { input: { status: 'known', accepts: ['image', 'pdf'] } } as const;

function candidate(id: string, caps: ModalityCandidate['capabilities'], label?: string): ModalityCandidate {
  return { id, capabilities: caps, ...(label ? { label } : {}) };
}

test('a text turn sends regardless of what the model can read', () => {
  assert.deepEqual(planForModalities({ attached: [], selected: textOnly }), { action: 'send' });
  assert.deepEqual(planForModalities({ attached: [], selected: null }), { action: 'send' });
});

test('a model that accepts everything attached just sends', () => {
  assert.deepEqual(planForModalities({ attached: ['image'], selected: vision }), { action: 'send' });
  assert.deepEqual(
    planForModalities({ attached: ['image', 'pdf'], selected: multimodal }),
    { action: 'send' },
  );
});

test('a known-unsupported attachment reroutes when another model can read it', () => {
  const plan = planForModalities({
    attached: ['image'],
    selected: textOnly,
    candidates: [candidate('m-text', textOnly), candidate('m-vision', vision, 'Vision Model')],
  });
  assert.deepEqual(plan, { action: 'reroute', to: 'm-vision', label: 'Vision Model', modality: 'image' });
});

test('rerouting requires a candidate that accepts EVERY attachment, not just one', () => {
  // Moving to a model that fixes the image and then cannot read the PDF is not
  // progress — it just relocates the silent loss.
  const plan = planForModalities({
    attached: ['image', 'pdf'],
    selected: textOnly,
    candidates: [candidate('m-vision', vision)],
  });
  assert.equal(plan.action, 'block');
});

test('a candidate covering every attachment is chosen', () => {
  const plan = planForModalities({
    attached: ['image', 'pdf'],
    selected: textOnly,
    candidates: [candidate('m-vision', vision), candidate('m-multi', multimodal)],
  });
  assert.deepEqual(plan, { action: 'reroute', to: 'm-multi', modality: 'image' });
});

test('an unverified candidate is not treated as a rescue', () => {
  // "Might work" is not a basis for silently moving the user's turn to a
  // different model.
  const plan = planForModalities({
    attached: ['image'],
    selected: textOnly,
    candidates: [candidate('m-unknown', unknown)],
  });
  assert.deepEqual(plan, { action: 'block', unsupported: ['image'] });
});

test('known-unsupported with no alternative blocks, listing what cannot be read', () => {
  const plan = planForModalities({ attached: ['image', 'pdf'], selected: textOnly });
  assert.deepEqual(plan, { action: 'block', unsupported: ['image', 'pdf'] });
});

test('unknown support sends but reports the uncertainty', () => {
  // Blocking here would break every model an operator never annotated;
  // sending silently is the status quo that loses the image.
  const plan = planForModalities({ attached: ['image'], selected: unknown });
  assert.deepEqual(plan, { action: 'send-unverified', unverified: ['image'] });
  assert.deepEqual(
    planForModalities({ attached: ['image'], selected: null }),
    { action: 'send-unverified', unverified: ['image'] },
  );
});

test('a definite problem outranks an uncertain one', () => {
  // image is definitely unreadable; pdf is merely unclassified. Reporting only
  // the uncertainty would bury the real failure.
  const imageOnly = { input: { status: 'known', accepts: ['pdf'] } } as const;
  const plan = planForModalities({ attached: ['image'], selected: imageOnly });
  assert.deepEqual(plan, { action: 'block', unsupported: ['image'] });
});

test('duplicate attachments of one kind collapse', () => {
  const plan = planForModalities({ attached: ['image', 'image'], selected: textOnly });
  assert.deepEqual(plan, { action: 'block', unsupported: ['image'] });
});

test('every non-send plan produces a message, and send produces none', () => {
  assert.equal(describeModalityPlan({ action: 'send' }), null);

  const reroute = describeModalityPlan({ action: 'reroute', to: 'm2', label: 'Vision', modality: 'image' });
  assert.match(reroute!, /cannot read image/);
  assert.match(reroute!, /Vision/);

  const blocked = describeModalityPlan({ action: 'block', unsupported: ['image'] });
  assert.match(blocked!, /no available model/i);
  assert.match(blocked!, /never saw/, 'the message must state the actual consequence');

  const unverifiedMsg = describeModalityPlan({ action: 'send-unverified', unverified: ['image'] });
  assert.match(unverifiedMsg!, /not recorded/);
  assert.match(unverifiedMsg!, /ignores the attachment/, 'tell the user what to watch for');
});

test('a reroute message falls back to the model id when it has no label', () => {
  const msg = describeModalityPlan({ action: 'reroute', to: 'gpt-vision-1', modality: 'image' });
  assert.match(msg!, /gpt-vision-1/);
});
