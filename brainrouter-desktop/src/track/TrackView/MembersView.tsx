/**
 * Track view — Members panel (roles, GitHub-collaborator pull, capability
 * matrix). Split out of TrackView.tsx byte-for-byte; no behavior change.
 */
import React, { useState } from 'react';
import type { ProjectMember, ProjectRole, ProjectCapability } from '@kinqs/brainrouter-types';
import { roleCan } from '../../lib/track/permissions.js';
import { Icon } from '../../icons.js';
import { TrackDropdown } from '../Dropdown.js';
import type { TrackOps } from './types.js';

const ROLES: Array<{ id: ProjectRole; label: string; blurb: string }> = [
  { id: 'owner', label: 'Owner', blurb: 'Full control, incl. members & deletion' },
  { id: 'admin', label: 'Admin', blurb: 'Manage members, automation, delete items' },
  { id: 'member', label: 'Member', blurb: 'Create, edit & plan work' },
  { id: 'viewer', label: 'Viewer', blurb: 'Read-only access to the board' },
];
const CAPS: Array<{ cap: ProjectCapability; label: string }> = [
  { cap: 'view', label: 'View board' },
  { cap: 'create-item', label: 'Create items' },
  { cap: 'edit-item', label: 'Edit & comment' },
  { cap: 'manage-sprints', label: 'Manage sprints' },
  { cap: 'delete-item', label: 'Delete items' },
  { cap: 'manage-automation', label: 'Automation' },
  { cap: 'manage-members', label: 'Manage members' },
];

export function MembersView({ members, ops }: { members: ProjectMember[]; ops: TrackOps }): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');
  const owners = members.filter((m) => m.role === 'owner').length;
  const soleOwner = (m: ProjectMember): boolean => m.role === 'owner' && owners === 1;

  const submit = (): void => {
    const handle = id.trim();
    if (!handle) return;
    ops.addMember({ id: handle, name: name.trim() || undefined, role });
    setId(''); setName(''); setRole('member'); setAdding(false);
  };

  return (
    <div className="track-members">
      <div className="track-section-head">
        Members <span className="track-col-count">{members.length}</span>
        <button className="track-member-pull" title="Import this repo's collaborators as members (roles mapped from their GitHub permission)" onClick={() => ops.syncMembers()}><Icon name="refresh" size={12} /> Pull from GitHub</button>
        <button className="track-auto-new" onClick={() => setAdding((a) => !a)}><Icon name={adding ? 'close' : 'plus'} size={12} /> {adding ? 'Cancel' : 'Add member'}</button>
      </div>
      <p className="track-auto-intro">Each member has a role that gates what they can do on this project. <b>Pull from GitHub</b> imports the repo's collaborators (admin → admin · write → member · read → viewer); the local owner is kept. The board, the CLI, and the agent all enforce the same policy.</p>

      {adding ? (
        <div className="track-member-form">
          <input className="track-member-id" autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="handle (username / email)" />
          <input className="track-member-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="display name (optional)" />
          <TrackDropdown className="dd-role" value={role} onChange={(v) => setRole(v as ProjectRole)}
            options={ROLES.map((r) => ({ value: r.id, label: r.label }))} />
          <button className="track-auto-save" disabled={!id.trim()} onClick={submit}>Add</button>
        </div>
      ) : null}

      <div className="track-member-list">
        {members.map((m) => (
          <div key={m.id} className="track-member-row">
            <span className="track-member-avatar">{(m.name ?? m.id).slice(0, 2).toUpperCase()}</span>
            <div className="track-member-id-col">
              <span className="track-member-disp">{m.name ?? m.id}</span>
              <span className="track-member-handle mono">{m.id}</span>
            </div>
            <TrackDropdown className="dd-role" value={m.role} disabled={soleOwner(m)} title={soleOwner(m) ? 'The sole owner role is locked' : 'Change role'}
              onChange={(v) => ops.updateMemberRole(m.id, v as ProjectRole)} options={ROLES.map((r) => ({ value: r.id, label: r.label }))} />
            <button className="track-member-del" title={soleOwner(m) ? 'Cannot remove the last owner' : 'Remove member'} disabled={soleOwner(m)} onClick={() => ops.removeMember(m.id)}><Icon name="trash" size={13} /></button>
          </div>
        ))}
      </div>

      <div className="track-perm-matrix">
        <div className="track-perm-title">What each role can do</div>
        <table>
          <thead><tr><th>Capability</th>{ROLES.map((r) => <th key={r.id}>{r.label}</th>)}</tr></thead>
          <tbody>
            {CAPS.map((c) => (
              <tr key={c.cap}>
                <td>{c.label}</td>
                {ROLES.map((r) => <td key={r.id} className={roleCan(r.id, c.cap) ? 'yes' : 'no'}>{roleCan(r.id, c.cap) ? '✓' : '·'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
