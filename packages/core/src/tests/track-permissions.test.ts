import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureProject,
  createWorkItem,
  updateWorkItem,
  addComment,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  canActor,
  memberRole,
  PermissionError,
  LOCAL_MEMBER_ID,
} from '../track/trackStore.js';
import { roleCan } from '@kinqs/brainrouter-types';
import { withTempWorkspace } from './_helpers.js';

test('permissions: a new project seeds one owner (the local operator)', () => {
  withTempWorkspace((ws) => {
    const project = ensureProject(ws, { key: 'BR' });
    assert.equal(project.members.length, 1);
    assert.equal(project.members[0].id, LOCAL_MEMBER_ID);
    assert.equal(project.members[0].role, 'owner');
    assert.equal(memberRole(ws, LOCAL_MEMBER_ID), 'owner');
  });
});

test('permissions: roleCan policy — viewer reads, member writes, admin manages', () => {
  assert.equal(roleCan('viewer', 'view'), true);
  assert.equal(roleCan('viewer', 'create-item'), false);
  assert.equal(roleCan('member', 'create-item'), true);
  assert.equal(roleCan('member', 'edit-item'), true);
  assert.equal(roleCan('member', 'delete-item'), false);
  assert.equal(roleCan('member', 'manage-members'), false);
  assert.equal(roleCan('admin', 'delete-item'), true);
  assert.equal(roleCan('admin', 'manage-members'), true);
  assert.equal(roleCan('owner', 'manage-automation'), true);
});

test('permissions: a viewer member is blocked from creating/editing; system actors are trusted', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    addMember(ws, { id: 'val', role: 'viewer' });
    // viewer cannot create
    assert.throws(() => createWorkItem(ws, { title: 'X', actor: 'val' }), PermissionError);
    // the default system actor ('user') still works
    const w = createWorkItem(ws, { title: 'X' });
    // viewer cannot edit or comment
    assert.throws(() => updateWorkItem(ws, w.key, { priority: 'high' }, 'val'), PermissionError);
    assert.throws(() => addComment(ws, w.key, 'val', 'hi'), PermissionError);
    // an unknown (non-member) actor is trusted in the local single-user model
    assert.equal(canActor(ws, 'random-bot', 'edit-item'), true);
  });
});

test('permissions: a member can create/edit but not manage members; admin can', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    addMember(ws, { id: 'mem', role: 'member' });
    const w = createWorkItem(ws, { title: 'Task', actor: 'mem' });
    assert.equal(updateWorkItem(ws, w.key, { priority: 'high' }, 'mem')!.priority, 'high');
    // member cannot add members
    assert.throws(() => addMember(ws, { id: 'x', role: 'viewer' }, 'mem'), PermissionError);
    // promote to admin → can now manage members
    addMember(ws, { id: 'mem', role: 'admin' }); // owner re-adds at admin
    assert.equal(memberRole(ws, 'mem'), 'admin');
    const added = addMember(ws, { id: 'newbie', role: 'viewer' }, 'mem');
    assert.equal(added.role, 'viewer');
  });
});

test('permissions: member CRUD round-trips and protects the last owner', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    addMember(ws, { id: 'ann', name: 'Ann', role: 'admin' });
    assert.equal(listMembers(ws).length, 2);
    // listMembers is sorted by privilege — owner first
    assert.equal(listMembers(ws)[0].role, 'owner');
    // change role
    assert.equal(updateMemberRole(ws, 'ann', 'member')!.role, 'member');
    // cannot demote or remove the last owner
    assert.throws(() => updateMemberRole(ws, LOCAL_MEMBER_ID, 'admin'), /last owner/);
    assert.throws(() => removeMember(ws, LOCAL_MEMBER_ID), /last owner/);
    // a second owner unlocks demotion of the first
    addMember(ws, { id: 'ann', role: 'owner' });
    assert.equal(updateMemberRole(ws, LOCAL_MEMBER_ID, 'admin')!.role, 'admin');
    // now 'ann' (owner) can remove the demoted operator
    assert.equal(removeMember(ws, LOCAL_MEMBER_ID, 'ann'), true);
    assert.equal(listMembers(ws).length, 1);
    assert.equal(listMembers(ws)[0].id, 'ann');
  });
});
