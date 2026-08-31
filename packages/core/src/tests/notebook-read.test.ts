/**
 * ADR-051 P1 (D1) — the notebook READ digest: the pure `renderNotebookDigest`
 * renderer, and `read_file` routing a `.ipynb` through it (with the `raw`
 * opt-out and the parse-failure fallback). Indices in the digest are the SAME
 * 0-based indices `notebook_edit` takes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderNotebookDigest } from '../agent/fs/notebookRead.js';
import { invokeBuiltinToolRuntime } from '../extension/builtin/runtime.js';

/** A small notebook: markdown intro, an executed code cell with a text output + a base64 image,
 *  an unexecuted code cell, and a code cell whose only output is an error. */
function sampleNotebook(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Title\n', 'intro'] },
      {
        cell_type: 'code', metadata: {}, execution_count: 3,
        source: ['import pandas as pd\n', 'df.head()'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['loaded 42 rows\n'] },
          { output_type: 'execute_result', execution_count: 3, data: { 'text/plain': ['   a  b\n0  1  2'], 'image/png': 'aaaabbbbccccdddd'.repeat(4000) }, metadata: {} },
        ],
      },
      { cell_type: 'code', metadata: {}, execution_count: null, source: ['x = 1'], outputs: [] },
      {
        cell_type: 'code', metadata: {}, execution_count: 5, source: ['1/0'],
        outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['[31mTraceback[0m', 'ZeroDivisionError: division by zero'] }],
      },
    ],
  }, null, 1);
}

test('digest names cells by the same 0-based index notebook_edit takes; code cells show execution state', () => {
  const d = renderNotebookDigest(sampleNotebook(), { label: 'a.ipynb' });
  assert.match(d, /Notebook: a\.ipynb — 4 cells \(nbformat 4\.5\)/);
  assert.match(d, /\[cell 0\] markdown/);
  assert.match(d, /# Title\nintro/);
  assert.match(d, /\[cell 1\] code \(executed: 3\)/);
  assert.match(d, /\[cell 2\] code \(unexecuted\)/);
  assert.match(d, /\[cell 3\] code \(executed: 5\)/);
});

test('image outputs are NAMED with an approx size, never inlined as base64', () => {
  const d = renderNotebookDigest(sampleNotebook());
  assert.match(d, /\[image output: image\/png, ~\d+ KB\]/, 'the image is named');
  assert.ok(!d.includes('aaaabbbb'.repeat(2)), 'the base64 payload is NOT inlined');
});

test('text and stream outputs are kept; errors show ename: evalue with a colour-stripped traceback', () => {
  const d = renderNotebookDigest(sampleNotebook());
  assert.match(d, /stream\(stdout\):\n\s+loaded 42 rows/);
  assert.match(d, /output\[text\/plain\]:\n\s+a {2}b/);
  assert.match(d, /error: ZeroDivisionError: division by zero/);
  assert.ok(!/\[31m/.test(d), 'ANSI colour codes are stripped from the traceback');
});

test('a chatty output is truncated so one cell cannot crowd out the notebook', () => {
  const big = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', execution_count: 1, source: ['print(x)'], outputs: [{ output_type: 'stream', name: 'stdout', text: 'x'.repeat(9000) }] }] });
  const d = renderNotebookDigest(big);
  assert.match(d, /more chars truncated/);
  assert.ok(d.length < 6000, 'the digest stays bounded');
});

test('renderNotebookDigest throws on non-notebook input (so the caller falls back to raw)', () => {
  assert.throws(() => renderNotebookDigest('not json'), /not valid JSON/);
  assert.throws(() => renderNotebookDigest('{"foo":1}'), /no "cells" array/);
});

test('read_file renders a .ipynb as the digest by default, and raw=true returns the JSON', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-read-'));
  try {
    fs.writeFileSync(path.join(ws, 'n.ipynb'), sampleNotebook());
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, reviewSourceSafety: false,
      filesReadThisSession: new Set<string>(), maybeReindexSource: async () => '',
    };
    const digest = await invokeBuiltinToolRuntime.call(host, 'read_file', { path: 'n.ipynb' });
    assert.match(digest, /\[cell 1\] code \(executed: 3\)/);
    assert.ok(!digest.includes('"cell_type"'), 'the default read is the digest, not raw JSON');

    const raw = await invokeBuiltinToolRuntime.call(host, 'read_file', { path: 'n.ipynb', raw: true });
    assert.match(raw, /"cell_type": "markdown"|"cell_type":"markdown"/, 'raw=true returns the underlying JSON');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('read_file falls back to raw content when a .ipynb is not a valid notebook', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-bad-'));
  try {
    fs.writeFileSync(path.join(ws, 'broken.ipynb'), 'this is not json');
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, reviewSourceSafety: false,
      filesReadThisSession: new Set<string>(), maybeReindexSource: async () => '',
    };
    const out = await invokeBuiltinToolRuntime.call(host, 'read_file', { path: 'broken.ipynb' });
    assert.match(out, /this is not json/, 'an invalid notebook reads as its raw bytes, not an error');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a line range slices the notebook digest like any other file', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-slice-'));
  try {
    fs.writeFileSync(path.join(ws, 'n.ipynb'), sampleNotebook());
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, reviewSourceSafety: false,
      filesReadThisSession: new Set<string>(), maybeReindexSource: async () => '',
    };
    const head = await invokeBuiltinToolRuntime.call(host, 'read_file', { path: 'n.ipynb', startLine: 1, endLine: 1 });
    assert.match(head, /^Notebook: n\.ipynb/);
    assert.ok(!head.includes('[cell 3]'), 'a 1-line slice does not include later cells');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
