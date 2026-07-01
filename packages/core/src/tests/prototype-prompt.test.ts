import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isHexColor,
  buildDesignSteering,
  buildPrototypePrompt,
} from '../prototype/prototypePrompt.js';
import { findPlaceholderTokens } from '../prototype/protoDetect.js';

test('isHexColor: accepts #rgb / #rrggbb, rejects the rest', () => {
  assert.ok(isHexColor('#fff'));
  assert.ok(isHexColor('#4f46e5'));
  assert.ok(isHexColor('  #ABCDEF  ')); // trimmed
  assert.ok(!isHexColor('red'));
  assert.ok(!isHexColor('#12'));
  assert.ok(!isHexColor('#gggggg'));
  assert.ok(!isHexColor('4f46e5'));
});

test('buildDesignSteering: empty when no usable direction', () => {
  assert.equal(buildDesignSteering(null), '');
  assert.equal(buildDesignSteering(undefined), '');
  assert.equal(buildDesignSteering({}), '');
  assert.equal(buildDesignSteering({ designType: '   ', tone: ['', '  '] }), '');
  assert.equal(buildDesignSteering({ brandColor: 'not-a-color' }), '', 'invalid color alone yields no steering');
});

test('buildDesignSteering: one bullet per provided field; drops invalid color + blank tones', () => {
  const s = buildDesignSteering({ designType: 'dashboard', brandColor: '#4f46e5', tone: ['minimal', '', ' playful '] });
  assert.match(s, /^Design direction/);
  assert.match(s, /Design type: dashboard/);
  assert.match(s, /#4f46e5/);
  assert.match(s, /Tone: minimal, playful/);

  const noColor = buildDesignSteering({ designType: 'landing page', brandColor: 'blue' });
  assert.match(noColor, /Design type: landing page/);
  assert.ok(!noColor.includes('brand color'), 'invalid brand color is dropped');
});

test('buildPrototypePrompt: carries requirement, reserved path, and the hard rules', () => {
  const prompt = buildPrototypePrompt({ requirement: '  A kanban board with drag-and-drop  ', reservedPath: 'proto/12345678.html' });
  assert.match(prompt, /A kanban board with drag-and-drop/);
  assert.ok(!prompt.includes('  A kanban'), 'requirement is trimmed');
  assert.match(prompt, /proto\/12345678\.html/);
  assert.match(prompt, /End the file with `<\/html>`/);
  assert.match(prompt, /No external network requests/);
  assert.match(prompt, /INTERACTIVE/);
});

test('buildPrototypePrompt: placeholders become resolvable tokens; absent → inline-SVG note', () => {
  const withPh = buildPrototypePrompt({ requirement: 'gallery', reservedPath: 'proto/a.html', placeholders: ['hero', 'avatar', '  '] });
  // the prompt embeds real tokens, and the detector can read the ids back out
  assert.deepEqual(findPlaceholderTokens(withPh).sort(), ['avatar', 'hero']);
  assert.ok(!withPh.includes('neutral inline SVG placeholder — never'), 'placeholder branch, not the SVG branch');

  const noPh = buildPrototypePrompt({ requirement: 'gallery', reservedPath: 'proto/a.html' });
  assert.deepEqual(findPlaceholderTokens(noPh), []);
  assert.match(noPh, /neutral inline SVG placeholder/);
});

test('buildPrototypePrompt: design steering appended only when present', () => {
  const steered = buildPrototypePrompt({ requirement: 'app', reservedPath: 'proto/a.html', design: { designType: 'mobile app', tone: ['playful'] } });
  assert.match(steered, /Design direction/);
  assert.match(steered, /mobile app/);

  const plain = buildPrototypePrompt({ requirement: 'app', reservedPath: 'proto/a.html' });
  assert.ok(!plain.includes('Design direction'), 'no steering block without a design context');
});
