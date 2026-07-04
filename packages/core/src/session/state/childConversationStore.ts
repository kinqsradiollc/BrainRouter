import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';

export type ChildConversationStatus = 'open' | 'closed';

export interface ChildConversationRecord {
  id: string;
  sessionKey: string;
  parentSessionKey: string;
  parentRuntimeId: string;
  repo: string;
  branch: string;
  model: string;
  title?: string;
  status: ChildConversationStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

interface ChildConversationFile {
  version: 1;
  conversations: ChildConversationRecord[];
}

export interface CreateChildConversationInput {
  parentSessionKey: string;
  parentRuntimeId: string;
  repo?: string;
  branch?: string;
  model?: string;
  title?: string;
}

function emptyFile(): ChildConversationFile {
  return { version: 1, conversations: [] };
}

function file(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'childConversations.json');
}

function read(workspaceRoot: string): ChildConversationFile {
  return readJsonFile<ChildConversationFile>(file(workspaceRoot), emptyFile());
}

function write(workspaceRoot: string, data: ChildConversationFile): void {
  writeJsonFile(file(workspaceRoot), data);
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return res.status === 0 ? res.stdout.trim() : '';
}

function detectRepo(workspaceRoot: string): string {
  const remote = git(workspaceRoot, ['config', '--get', 'remote.origin.url']);
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return match ? match[1] : '';
}

function detectBranch(workspaceRoot: string): string {
  return git(workspaceRoot, ['branch', '--show-current']);
}

export function createChildConversation(
  workspaceRoot: string,
  input: CreateChildConversationInput,
): ChildConversationRecord {
  const parentSessionKey = input.parentSessionKey.trim();
  const parentRuntimeId = input.parentRuntimeId.trim();
  if (!parentSessionKey) throw new Error('parentSessionKey is required');
  if (!parentRuntimeId) throw new Error('parentRuntimeId is required');
  const now = new Date().toISOString();
  const id = `conv_${randomUUID().slice(0, 8)}`;
  const record: ChildConversationRecord = {
    id,
    sessionKey: `${parentSessionKey}:child:${id}`,
    parentSessionKey,
    parentRuntimeId,
    repo: input.repo?.trim() || detectRepo(workspaceRoot),
    branch: input.branch?.trim() || detectBranch(workspaceRoot),
    model: input.model?.trim() || '',
    title: input.title?.trim() || undefined,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
  const data = read(workspaceRoot);
  data.conversations.push(record);
  write(workspaceRoot, data);
  return record;
}

export function listChildConversations(workspaceRoot: string): ChildConversationRecord[] {
  return read(workspaceRoot).conversations;
}

export function getChildConversation(workspaceRoot: string, id: string): ChildConversationRecord | undefined {
  return read(workspaceRoot).conversations.find((c) => c.id === id || c.sessionKey === id);
}

export function closeChildConversation(workspaceRoot: string, id: string): ChildConversationRecord | undefined {
  const data = read(workspaceRoot);
  const idx = data.conversations.findIndex((c) => c.id === id || c.sessionKey === id);
  if (idx < 0) return undefined;
  const now = new Date().toISOString();
  data.conversations[idx] = { ...data.conversations[idx], status: 'closed', closedAt: now, updatedAt: now };
  write(workspaceRoot, data);
  return data.conversations[idx];
}
