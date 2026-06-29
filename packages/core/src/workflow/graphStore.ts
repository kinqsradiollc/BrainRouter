/**
 * WORKFLOW GRAPH STORE (§7 L4) — durable, workspace-scoped persistence for the
 * visual canvas's {@link WorkflowGraph}s, one JSON per graph under
 * `<stateDir>/workflows/`. The desktop canvas saves/loads through this (via host
 * queries), and saved graphs can later be exposed to the agent as runnable tools.
 *
 * Pure fs over the storage helpers; ids are filename-sanitized. Unit-testable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getStateDir } from '../storage/store.js';
import type { WorkflowGraph } from './graph.js';

export interface SavedWorkflowMeta {
  id: string;
  name: string;
  updatedAt: string;
}

function workflowsDir(workspaceRoot: string): string {
  const dir = path.join(getStateDir(workspaceRoot), 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Filesystem-safe id (no traversal, no exotic chars). */
function safeId(raw: string): string {
  return (raw || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'untitled';
}

function graphFile(workspaceRoot: string, id: string): string {
  return path.join(workflowsDir(workspaceRoot), `${safeId(id)}.json`);
}

/** Persist a graph (id derived from `graph.id` or `graph.name`). Stamps `updatedAt`. */
export function saveWorkflowGraph(workspaceRoot: string, graph: WorkflowGraph): SavedWorkflowMeta {
  const id = safeId(graph.id || graph.name || 'untitled');
  const record: WorkflowGraph & { updatedAt: string } = {
    ...graph,
    id,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(graphFile(workspaceRoot, id), JSON.stringify(record, null, 2), 'utf8');
  return { id, name: graph.name || id, updatedAt: record.updatedAt };
}

/** Load a saved graph by id, or null when missing/corrupt. */
export function loadWorkflowGraph(workspaceRoot: string, id: string): WorkflowGraph | null {
  const file = graphFile(workspaceRoot, id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowGraph;
  } catch {
    return null;
  }
}

/** Saved-graph metadata, newest first. */
export function listWorkflowGraphs(workspaceRoot: string): SavedWorkflowMeta[] {
  const dir = workflowsDir(workspaceRoot);
  const out: SavedWorkflowMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const g = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as WorkflowGraph & { updatedAt?: string };
      const id = g.id || name.replace(/\.json$/, '');
      out.push({ id, name: g.name || id, updatedAt: g.updatedAt || '' });
    } catch {
      /* skip a corrupt file */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Delete a saved graph; returns false when it didn't exist. */
export function deleteWorkflowGraph(workspaceRoot: string, id: string): boolean {
  const file = graphFile(workspaceRoot, id);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
