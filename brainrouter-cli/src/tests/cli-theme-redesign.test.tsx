import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { buildTheme } from '../cli/theme/theme.js';
import { TuiHeader } from '../cli/ink/components/TuiHeader.js';
import { WelcomeView } from '../cli/ink/views/WelcomeView.js';

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');

test('CLI theme uses the shared semantic spectrum and mono stays byte-plain', () => {
  const dark = buildTheme('dark');
  assert.deepEqual(dark.colors, {
    primary: '#8B7CFF',
    secondary: '#FF8B73',
    info: '#4DD8FF',
    automation: '#A3E635',
    success: '#22C55E',
    warning: '#EAB308',
    danger: '#EF4444',
  });

  const mono = buildTheme('mono');
  for (const token of ['primary', 'secondary', 'success', 'warning', 'danger', 'info', 'muted', 'dim', 'heading', 'plain'] as const) {
    assert.equal(mono[token]('copy me'), 'copy me', `mono.${token} must not emit ANSI`);
  }
  assert.deepEqual(mono.colors, {});
});

test('TUI header is compact and never draws past the requested width', () => {
  const view = render(
    <TuiHeader
      cols={42}
      theme={buildTheme('mono')}
      mcpProfile='local-http'
      mcpTransport='http'
      mcpOnline
      mcpIdentity='brainrouter'
    />,
  );
  const frame = stripAnsi(view.lastFrame() ?? '');
  assert.match(frame, /brainrouter cli/i);
  assert.doesNotMatch(frame, /BRAINROUTER CLI/);
  for (const line of frame.split('\n')) {
    assert.ok([...line].length <= 42, `line exceeded terminal width: ${line}`);
  }
  view.unmount();
});

test('home view is a compact task-oriented launch surface rather than an ASCII logo wall', () => {
  const view = render(
    <WelcomeView workspaceRoot='/work/acme-api' theme={buildTheme('mono')} />,
  );
  const frame = stripAnsi(view.lastFrame() ?? '');
  assert.match(frame, /Ready to build/);
  assert.match(frame, /Session/);
  assert.match(frame, /Workflows/);
  assert.match(frame, /Connections/);
  assert.match(frame, /acme-api/);
  assert.doesNotMatch(frame, /█/);
  view.unmount();
});
