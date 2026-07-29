import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectTerminalRead,
  projectTerminalSession,
  projectTerminalShellCatalog,
} from './index.js';

test('terminal protocol accepts bounded host projections and returns copies', () => {
  const catalog = {
    selected: 'zsh',
    shells: [{ id: 'zsh', label: 'Z shell', description: 'Open Z shell.', isDefault: true }],
  };
  const projectedCatalog = projectTerminalShellCatalog(catalog);
  assert.deepEqual(projectedCatalog, catalog);
  assert.notEqual(projectedCatalog, catalog);
  assert.notEqual(projectedCatalog?.shells, catalog.shells);

  assert.deepEqual(projectTerminalSession({
    id: 't1',
    shellId: 'zsh',
    label: 'Z shell',
    reused: false,
    snapshot: '',
    start: 0,
    next: 0,
    alive: true,
  }), {
    id: 't1',
    shellId: 'zsh',
    label: 'Z shell',
    reused: false,
    snapshot: '',
    start: 0,
    next: 0,
    alive: true,
  });

  assert.deepEqual(projectTerminalRead({
    chunk: 'ready\r\n',
    next: 7,
    alive: true,
    dropped: 0,
  }), {
    chunk: 'ready\r\n',
    next: 7,
    alive: true,
    dropped: 0,
  });
});

test('terminal protocol rejects malformed, unbounded, and inconsistent projections', () => {
  assert.equal(projectTerminalShellCatalog({ selected: 'missing', shells: [] }), null);
  assert.equal(projectTerminalShellCatalog({
    selected: 'zsh',
    shells: [{ id: 'zsh', label: '', description: 'Open Z shell.', isDefault: true }],
  }), null);
  assert.equal(projectTerminalSession({
    id: 't1',
    shellId: 'zsh',
    label: 'Z shell',
    reused: false,
    snapshot: '',
    start: 2,
    next: 1,
    alive: true,
  }), null);
  assert.equal(projectTerminalRead({
    chunk: '',
    next: -1,
    alive: true,
    dropped: 0,
  }), null);
});
