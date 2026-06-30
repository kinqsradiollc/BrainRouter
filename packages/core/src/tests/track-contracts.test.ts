import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkItemType,
  isStatusCategory,
  isWorkItemPriority,
  isSprintState,
  isBoardType,
  isWorkItemLinkType,
  isCodeLinkKind,
  isTrackProject,
  isWorkItem,
  isSprint,
  isBoard,
  DEFAULT_WORKFLOW_STATES,
  DEFAULT_ISSUE_TYPES,
  type TrackProject,
  type WorkItem,
  type Sprint,
  type Board,
} from '@kinqs/brainrouter-types';

test('track enum guards: accept members, reject non-members', () => {
  assert.ok(isWorkItemType('epic') && isWorkItemType('sub-task'));
  assert.ok(!isWorkItemType('feature') && !isWorkItemType(3));
  assert.ok(isStatusCategory('started') && !isStatusCategory('blocked'));
  assert.ok(isWorkItemPriority('urgent') && !isWorkItemPriority('highest'));
  assert.ok(isSprintState('active') && !isSprintState('paused'));
  assert.ok(isBoardType('scrum') && !isBoardType('list'));
  assert.ok(isWorkItemLinkType('blocked-by') && !isWorkItemLinkType('parent'));
  assert.ok(isCodeLinkKind('pull-request') && !isCodeLinkKind('issue'));
});

test('defaults: workflow spans backlog→completed, issue types include epic + sub-task', () => {
  const cats = DEFAULT_WORKFLOW_STATES.map((s) => s.category);
  assert.ok(cats.includes('backlog') && cats.includes('started') && cats.includes('completed'));
  assert.ok(DEFAULT_WORKFLOW_STATES.every((s) => isStatusCategory(s.category)));
  assert.ok(DEFAULT_WORKFLOW_STATES.every((s) => typeof s.color === 'string' && s.color.startsWith('#')));
  assert.equal(DEFAULT_WORKFLOW_STATES.filter((s) => s.default).length, 1); // exactly one default state
  const types = DEFAULT_ISSUE_TYPES.map((t) => t.type);
  assert.ok(types.includes('epic') && types.includes('sub-task'));
  assert.equal(DEFAULT_ISSUE_TYPES.find((t) => t.type === 'sub-task')?.subtask, true);
});

const project: TrackProject = {
  id: 'proj_1',
  workspaceRoot: '/tmp/ws',
  name: 'BrainRouter',
  key: 'BR',
  keyCounter: 1,
  workflowStates: [...DEFAULT_WORKFLOW_STATES],
  issueTypes: [...DEFAULT_ISSUE_TYPES],
  components: ['cli', 'desktop'],
  labels: [{ id: 'lbl_1', name: 'track', color: '#3b82f6' }],
  members: [{ id: 'you', name: 'You', role: 'owner', addedAt: '2026-06-21T00:00:00.000Z' }],
  createdAt: '2026-06-21T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
};

const workItem: WorkItem = {
  id: 'wi_1',
  key: 'BR-1',
  type: 'story',
  title: 'Add the Track board',
  status: 'in-progress',
  statusCategory: 'started',
  priority: 'high',
  assignees: ['anhdang'],
  watchers: [],
  labels: ['track'],
  components: ['desktop'],
  links: [{ type: 'blocks', targetId: 'wi_2' }],
  comments: [],
  attachmentIds: [],
  activity: [{ at: '2026-06-21T00:00:00.000Z', actor: 'agent', field: 'created' }],
  workspaceRoot: '/tmp/ws',
  linkedMemoryIds: [],
  codeLinks: [{ kind: 'branch', ref: 'feat/unified-workspace' }],
  taskIds: [],
  artifactIds: [],
  reviewFindingIds: [],
  createdAt: '2026-06-21T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
};

test('isTrackProject / isWorkItem: accept well-formed records', () => {
  assert.ok(isTrackProject(project));
  assert.ok(isWorkItem(workItem));
});

test('isWorkItem: rejects a bad type, bad category, and missing arrays', () => {
  assert.ok(!isWorkItem({ ...workItem, type: 'feature' }));
  assert.ok(!isWorkItem({ ...workItem, statusCategory: 'blocked' }));
  assert.ok(!isWorkItem({ ...workItem, labels: 'track' }));
  assert.ok(!isWorkItem({ ...workItem, linkedMemoryIds: undefined }));
  assert.ok(!isWorkItem(null) && !isWorkItem('x'));
});

test('isSprint / isBoard: accept well-formed, reject bad enums', () => {
  const sprint: Sprint = {
    id: 'sp_1', workspaceRoot: '/tmp/ws', name: 'Sprint 1', state: 'active',
    createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z',
  };
  assert.ok(isSprint(sprint));
  assert.ok(!isSprint({ ...sprint, state: 'paused' }));

  const board: Board = {
    id: 'bd_1', workspaceRoot: '/tmp/ws', name: 'Main', type: 'kanban',
    columns: [{ name: 'To Do', stateIds: ['todo'] }, { name: 'Doing', stateIds: ['in-progress', 'in-review'] }],
    createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z',
  };
  assert.ok(isBoard(board));
  assert.ok(!isBoard({ ...board, type: 'timeline' }));
  assert.ok(!isBoard({ ...board, columns: [{ name: 'x' }] }));
});
