import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  Picker,
  type PickerResult,
} from '../cli/ink/prompt/Picker.js';

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');

test('catalog multi-select opens with reviewed choices checked', () => {
  const view = render(
    <Picker
      title='Tools'
      rows={[
        { id: 'coding', label: 'Files and code' },
        { id: 'browser', label: 'Web and research' },
      ]}
      multiSelect
      initialSelected={['browser', 'unknown']}
      allowEmptySelection
      onResolve={() => undefined}
    />,
  );
  const frame = stripAnsi(view.lastFrame() ?? '');
  assert.match(frame, /\[ \] Files and code/);
  assert.match(frame, /\[x\] Web and research/);
  assert.doesNotMatch(frame, /unknown/);
  view.unmount();
});

test('catalog multi-select can intentionally confirm an empty Custom setup', async () => {
  let result: PickerResult | undefined;
  const view = render(
    <Picker
      title='Tools'
      rows={[{ id: 'coding', label: 'Files and code' }]}
      multiSelect
      allowEmptySelection
      onResolve={(value) => { result = value; }}
    />,
  );
  view.stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(result, { kind: 'multi', id: '', ids: [] });
  view.unmount();
});
