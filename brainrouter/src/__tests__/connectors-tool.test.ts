import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnector } from '@kinqs/brainrouter-core/connectors';
import {
  connectorListToolSchema,
  connectorRunToolSchema,
  handleConnectorList,
  handleConnectorRun,
} from '../tools/atlas/connectors.js';

// These tests exercise the MCP connector tools OFFLINE: connector_list reads the
// file-based connector store, and connector_run's failure path (oauth github with
// no host client) returns the desktop-only guidance without any network or DB.

let workspace: string;
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'br-conn-ws-'));
  home = mkdtempSync(join(tmpdir(), 'br-conn-home-'));
  prevHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.BRAINROUTER_HOME;
  else process.env.BRAINROUTER_HOME = prevHome;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function textOf(result: { content?: Array<{ text?: string }> }): string {
  return result.content?.[0]?.text ?? '';
}

describe('connector MCP tool schemas', () => {
  it('expose stable tool names and required args', () => {
    expect(connectorListToolSchema.name).toBe('connector_list');
    expect(connectorRunToolSchema.name).toBe('connector_run');
    expect((connectorRunToolSchema.inputSchema as { required?: readonly string[] }).required).toEqual(['connectorId']);
  });
});

describe('handleConnectorList', () => {
  it('returns configured connectors (id/source/status/lastRunAt/lastError)', async () => {
    const created = createConnector(workspace, {
      source: 'filesystem',
      name: 'FS',
      config: { roots: ['docs'] },
      credential: { mode: 'none' },
      flows: ['checkpoint'],
    });
    const result = await handleConnectorList({}, { workspaceRoot: workspace });
    const rows = JSON.parse(textOf(result)) as Array<{ id: string; source: string; status: string; lastRunAt: string | null; lastError: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.id, source: 'filesystem', status: 'active', lastRunAt: null, lastError: null });
  });

  it('filters by source', async () => {
    createConnector(workspace, { source: 'filesystem', name: 'FS', config: { roots: ['a'] }, credential: { mode: 'none' }, flows: ['checkpoint'] });
    createConnector(workspace, { source: 'web', name: 'Web', config: { urls: ['https://example.test'] }, credential: { mode: 'none' }, flows: ['checkpoint'] });
    const result = await handleConnectorList({ source: 'web' }, { workspaceRoot: workspace });
    const rows = JSON.parse(textOf(result)) as Array<{ source: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('web');
  });
});

describe('handleConnectorRun', () => {
  it('returns the desktop-only guidance for an oauth github connector (no host client)', async () => {
    const created = createConnector(workspace, {
      source: 'github',
      name: 'GH',
      config: { owner: 'kinqsradiollc' },
      credential: { mode: 'oauth', ref: 'gh' },
      flows: ['checkpoint'],
    });
    const result = await handleConnectorRun({ connectorId: created.id }, { workspaceRoot: workspace, defaultUserId: 'default' });
    const payload = JSON.parse(textOf(result)) as { ok: boolean; failures: string[]; importedToMemory: number };
    expect(payload.ok).toBe(false);
    expect(payload.importedToMemory).toBe(0);
    expect(payload.failures.join(' ')).toMatch(/run it from BrainRouter Desktop/);
  });

  it('errors for an unknown connector id', async () => {
    const result = await handleConnectorRun({ connectorId: 'conn_missing' }, { workspaceRoot: workspace });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result as { content?: Array<{ text?: string }> })).toMatch(/Connector not found/);
  });
});
