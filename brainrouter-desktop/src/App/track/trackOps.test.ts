import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackOps } from './trackOps.js';

type Call = { id: string; name: string; args?: Record<string, unknown> };

test('desktop Track operations route every visible mutation to its host contract', () => {
  const calls: Call[] = [];
  const ops = buildTrackOps((id, name, args) => calls.push({ id, name, args }));

  ops.create({ title: 'Ship it', type: 'task', status: 'todo' });
  ops.transition('BR-1', 'done');
  ops.update('BR-1', { title: 'Shipped' });
  ops.comment('BR-1', 'Verified');
  ops.link('BR-1', { linkedMemoryIds: ['memory-1'], blocks: 'BR-2' });
  ops.assignSprint('BR-1', 'sprint-1');
  ops.createSprint('Sprint 1', 'Finish');
  ops.sprintState('sprint-1', 'active');
  ops.assignModule('BR-1', 'module-1');
  ops.createModule('Desktop', 'Workbench');
  ops.updateModule('module-1', { name: 'Desktop app' });
  ops.deleteModule('module-1');
  ops.saveView({ name: 'Mine', layout: 'list', filters: { assignee: 'me' } });
  ops.deleteView('view-1');
  ops.createAutomation({ name: 'Done', trigger: 'transitioned', actions: [{ type: 'set-priority', value: 'high' }] });
  ops.updateAutomation('automation-1', { enabled: false });
  ops.deleteAutomation('automation-1');
  ops.addMember({ id: 'octocat', name: 'Octo Cat', role: 'member' });
  ops.updateMemberRole('octocat', 'admin');
  ops.removeMember('octocat');
  ops.syncMembers();
  ops.sync('sync', true);
  ops.importGhIssues();
  ops.scanCommits();
  ops.refreshGit();
  ops.startGitWork('BR-1');
  ops.refreshPr();
  ops.createDraftPr('BR-1');
  ops.mergePr();
  ops.submitPrReview('request-changes', 'Please add coverage.');
  ops.fixFailingChecks();

  assert.deepEqual(calls.map((call) => call.name), [
    'track-create', 'track-transition', 'track-update-item', 'track-comment', 'track-link',
    'track-assign-sprint', 'track-create-sprint', 'track-sprint-state', 'track-assign-module',
    'track-create-module', 'track-module-update', 'track-module-delete', 'track-save-view',
    'track-delete-view', 'track-create-automation', 'track-update-automation',
    'track-delete-automation', 'track-add-member', 'track-update-member-role',
    'track-remove-member', 'track-sync-members', 'track-sync', 'track-gh-issues-import',
    'track-scan-commits', 'track-git-context', 'track-start-work', 'track-pr-status',
    'track-create-pr', 'track-merge-pr', 'track-submit-pr-review', 'track-fix-failing-checks',
  ]);
  assert.deepEqual(calls.find((call) => call.name === 'track-sync')?.args, { direction: 'sync', dryRun: true });
  assert.deepEqual(calls.find((call) => call.name === 'track-save-view')?.args, {
    input: { name: 'Mine', layout: 'list', filters: { assignee: 'me' } },
  });
});

test('Track sync waits for its completion payload instead of scheduling a stale board refresh', () => {
  const calls: Call[] = [];
  const ops = buildTrackOps((id, name, args) => calls.push({ id, name, args }));
  ops.sync('import', true);
  ops.sync('export', false);
  assert.deepEqual(calls, [
    { id: 'q-track-sync', name: 'track-sync', args: { direction: 'import', dryRun: true } },
    { id: 'q-track-sync', name: 'track-sync', args: { direction: 'export', dryRun: false } },
  ]);
});
