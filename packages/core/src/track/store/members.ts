/**
 * TRACK store — members & permissions.
 *
 * The project's member roster and the capability check that gates mutations.
 * `assertCan` is the shared guard the work-item mutators call, so it lives here
 * with the roster it consults.
 */
import {
  type ProjectMember,
  type ProjectRole,
  type ProjectCapability,
  roleCan,
  ROLE_RANK,
} from '@kinqs/brainrouter-types';
import { readTrack, writeTrack, nowIso } from './_internal.js';
import { ensureProject, getProject } from './project.js';
import type { AddMemberInput } from './types.js';

/**
 * Actors the local runtime trusts unconditionally: the human operator (`user`),
 * the AI (`agent`), and internal writers (`auto`/`automation`/`system`). Only a
 * *named project member* acting as themselves is role-checked — this keeps the
 * single-user app fully functional while making roles real for any caller that
 * passes a member id as the actor (federation, shared boards, scripted members).
 */
const SYSTEM_ACTORS = new Set(['user', 'agent', 'auto', 'automation', 'system']);

/** Thrown when an actor lacks the capability for an operation. */
export class PermissionError extends Error {
  constructor(public actor: string, public capability: ProjectCapability) {
    super(`"${actor}" is not permitted to ${capability.replace(/-/g, ' ')} on this project`);
    this.name = 'PermissionError';
  }
}

export function listMembers(workspaceRoot: string): ProjectMember[] {
  const project = getProject(workspaceRoot);
  return project?.members ? [...project.members].sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]) : [];
}

/** Resolve an actor's effective role, or `undefined` if they aren't a tracked member. */
export function memberRole(workspaceRoot: string, actor: string): ProjectRole | undefined {
  return getProject(workspaceRoot)?.members?.find((m) => m.id === actor)?.role;
}

/**
 * May `actor` perform `capability`? System actors and non-members are trusted
 * (local single-user default); tracked members are checked against their role.
 */
export function canActor(workspaceRoot: string, actor: string, capability: ProjectCapability): boolean {
  if (SYSTEM_ACTORS.has(actor)) return true;
  const role = memberRole(workspaceRoot, actor);
  if (!role) return true; // not a tracked member → local trust
  return roleCan(role, capability);
}

export function assertCan(workspaceRoot: string, actor: string, capability: ProjectCapability): void {
  if (!canActor(workspaceRoot, actor, capability)) throw new PermissionError(actor, capability);
}

/** Add a member (or update their role/name if already present). Requires `manage-members`. */
export function addMember(workspaceRoot: string, input: AddMemberInput, actor = 'user'): ProjectMember {
  ensureProject(workspaceRoot);
  assertCan(workspaceRoot, actor, 'manage-members');
  const store = readTrack(workspaceRoot);
  const project = store.project!;
  const id = input.id.trim();
  if (!id) throw new Error('Member id is required.');
  const role = input.role ?? 'member';
  const existing = project.members.find((m) => m.id === id);
  if (existing) {
    if (existing.role === 'owner' && role !== 'owner' && project.members.filter((m) => m.role === 'owner').length === 1) {
      throw new Error('Cannot demote the last owner.');
    }
    existing.role = role;
    if (input.name !== undefined) existing.name = input.name;
  } else {
    project.members.push({ id, name: input.name, role, addedAt: nowIso() });
  }
  project.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return project.members.find((m) => m.id === id)!;
}

/** Change a member's role. Requires `manage-members`; refuses to remove the last owner. */
export function updateMemberRole(workspaceRoot: string, id: string, role: ProjectRole, actor = 'user'): ProjectMember | undefined {
  assertCan(workspaceRoot, actor, 'manage-members');
  const store = readTrack(workspaceRoot);
  const project = store.project;
  const member = project?.members.find((m) => m.id === id);
  if (!project || !member) return undefined;
  if (member.role === 'owner' && role !== 'owner' && project.members.filter((m) => m.role === 'owner').length === 1) {
    throw new Error('Cannot demote the last owner.');
  }
  member.role = role;
  project.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return member;
}

/** Remove a member. Requires `manage-members`; refuses to remove the last owner. */
export function removeMember(workspaceRoot: string, id: string, actor = 'user'): boolean {
  assertCan(workspaceRoot, actor, 'manage-members');
  const store = readTrack(workspaceRoot);
  const project = store.project;
  const member = project?.members.find((m) => m.id === id);
  if (!project || !member) return false;
  if (member.role === 'owner' && project.members.filter((m) => m.role === 'owner').length === 1) {
    throw new Error('Cannot remove the last owner.');
  }
  project.members = project.members.filter((m) => m.id !== id);
  project.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return true;
}
