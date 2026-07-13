import test from 'node:test';
import assert from 'node:assert/strict';
import { rowSource, matchScreen, routeOfUrl, normRoute, slug, symbolKindIcon } from './rowSource.js';
import type { UiMap } from '@kinqs/brainrouter-ui-test';

const MAP: UiMap = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  screens: [
    {
      id: 'login', title: 'Login', platform: 'web', route: '/login',
      filePath: 'examples/mock-ui/screens/Login.tsx',
      elements: [
        { id: 'login-submit', testID: 'login-submit', type: 'button', action: 'tap', label: 'Sign in', filePath: 'examples/mock-ui/screens/Login.tsx', line: 14, kind: 'component', component: 'LoginScreen' },
        { id: 'email-field', testID: 'email-field', type: 'input', action: 'type', label: 'Email', filePath: 'examples/mock-ui/screens/Login.tsx' },
      ],
    },
    {
      id: 'todos', title: 'Todos', platform: 'web', route: '/todos',
      filePath: 'examples/mock-ui/screens/Todos.tsx',
      elements: [
        { id: 'todo-add', testID: 'todo-add', type: 'button', action: 'tap', filePath: 'examples/mock-ui/screens/Todos.tsx', line: 22 },
      ],
    },
  ],
};

test('slug kebabs a human label', () => {
  assert.equal(slug('Add todo'), 'add-todo');
  assert.equal(slug('  Increment! '), 'increment');
});

test('normRoute strips #, leading/trailing slashes, lowercases', () => {
  assert.equal(normRoute('#/Todos/'), 'todos');
  assert.equal(normRoute('/login'), 'login');
});

test('routeOfUrl reads hash route first, else pathname', () => {
  assert.equal(routeOfUrl('http://localhost:5174/#/todos'), 'todos');
  assert.equal(routeOfUrl('http://localhost:5174/login'), 'login');
});

test('matchScreen finds a screen by normalized route', () => {
  assert.equal(matchScreen(MAP, 'http://localhost:5174/#/login')?.id, 'login');
  assert.equal(matchScreen(MAP, 'http://x/#/nope'), undefined);
  assert.equal(matchScreen(null, 'http://x/#/login'), undefined);
});

test('exact: testid in map -> element file:line and ref', () => {
  const s = rowSource({ role: 'button', name: 'Sign in', testid: 'login-submit' }, MAP, 'http://x/#/login');
  assert.equal(s.exact, true);
  assert.equal(s.filePath, 'examples/mock-ui/screens/Login.tsx');
  assert.equal(s.line, 14);
  assert.equal(s.ref, 'examples/mock-ui/screens/Login.tsx:14#login-submit');
  assert.equal(s.kind, 'component');
  assert.equal(s.component, 'LoginScreen');
});

test('symbolKindIcon maps kinds to icon names, dots for unknown', () => {
  assert.equal(symbolKindIcon('component'), 'layout');
  assert.equal(symbolKindIcon('function'), 'code');
  assert.equal(symbolKindIcon('class'), 'command');
  assert.equal(symbolKindIcon('feature'), 'spark');
  assert.equal(symbolKindIcon('journey'), 'branch');
  assert.equal(symbolKindIcon(undefined), 'dots');
});

test('exact without a line -> ref omits :line', () => {
  const s = rowSource({ role: 'textbox', name: 'Email', testid: 'email-field' }, MAP, 'http://x/#/login');
  assert.equal(s.exact, true);
  assert.equal(s.line, undefined);
  assert.equal(s.ref, 'examples/mock-ui/screens/Login.tsx#email-field');
});

test('screen fallback: unknown testid but route matches -> screen file', () => {
  const s = rowSource({ role: 'button', name: 'Mystery', testid: 'not-in-map' }, MAP, 'http://x/#/todos');
  assert.equal(s.exact, false);
  assert.equal(s.filePath, 'examples/mock-ui/screens/Todos.tsx');
  assert.equal(s.line, undefined);
  assert.equal(s.ref, 'examples/mock-ui/screens/Todos.tsx#not-in-map');
});

test('screen fallback: no testid -> anchor is slug(name)', () => {
  const s = rowSource({ role: 'heading', name: 'My Todos' }, MAP, 'http://x/#/todos');
  assert.equal(s.filePath, 'examples/mock-ui/screens/Todos.tsx');
  assert.equal(s.ref, 'examples/mock-ui/screens/Todos.tsx#my-todos');
});

test('none: null map -> no file, human ref', () => {
  const s = rowSource({ role: 'button', name: 'Increment', testid: 'counter-increment' }, null, 'http://x/#/home');
  assert.equal(s.filePath, undefined);
  assert.equal(s.exact, false);
  assert.equal(s.ref, 'Increment (button)');
});

test('none: testid not in map and route has no screen -> human ref', () => {
  const s = rowSource({ role: 'button', name: 'Ghost', testid: 'ghost' }, MAP, 'http://x/#/unknown');
  assert.equal(s.filePath, undefined);
  assert.equal(s.ref, 'Ghost (button)');
});
