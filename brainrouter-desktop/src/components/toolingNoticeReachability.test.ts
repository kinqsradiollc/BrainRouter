/**
 * ADR-028 I1 — the notice has to REPORT the install, on the launch it ran.
 *
 * The renderer carried its own structural copy of the plan type with no
 * `auto_install` arm, so on the default `cli.autoInstallTools: 'safe'` — the
 * exact configuration Part I exists for — it fell through to
 * `plan.missing[0]` on an action that has no `missing` and threw during
 * render. There is no error boundary above it, so the whole tree went down
 * and the person saw nothing about what ran. The tests below drive every arm
 * `planProvisioning` can actually produce, so no arm can be unreachable again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type React from 'react';
import { planProvisioning, TOOL_REQUIREMENTS } from '@kinqs/brainrouter-core/tooling';
import { ToolingNoticeBody, type ToolingNoticeBodyProps } from './ToolingNotice.js';

type Element = { type: unknown; props: Record<string, unknown> };

function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function walk(node: unknown, out: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  walk(node.props.children, out);
  return out;
}

function text(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const child of node) text(child, out); return out; }
  if (isElement(node)) text(node.props.children, out);
  return out;
}

function render(props: Partial<ToolingNoticeBodyProps> & Pick<ToolingNoticeBodyProps, 'plan'>) {
  const writes: Array<string | null> = [];
  const element = ToolingNoticeBody({
    installed: [],
    showCommand: null,
    setShowCommand: (value) => writes.push(value),
    decline: () => {},
    ...props,
  }) as unknown as React.ReactElement | null;
  return { element, tree: element ? walk(element) : [], writes };
}

/** The plan a default install actually produces when the extension is absent. */
function autoInstallPlan() {
  const plan = planProvisioning(
    [{ id: 'git', present: true }, { id: 'gh', present: true }, { id: 'gh-stack', present: false }],
    { declined: new Set(), autoInstall: 'safe' },
  );
  assert.equal(plan.kind, 'auto_install', 'precondition: the default configuration auto-installs gh-stack');
  return plan;
}

test('the default configuration renders instead of throwing, because gh-stack is the only auto-installable tool', () => {
  // This is the regression itself: `plan.missing` is undefined on this arm, and
  // the previous renderer indexed it unconditionally.
  const { element } = render({ plan: autoInstallPlan(), installed: ['the gh-stack extension'] });
  assert.ok(element, 'the auto-install arm rendered nothing at all');
});

test('the notice says what was installed, which is the whole point of reporting rather than doing it silently', () => {
  const { tree } = render({ plan: autoInstallPlan(), installed: ['the gh-stack extension'] });
  const copy = text(tree.find((el) => el.props.className === 'tool-notice-msg')?.props.children).join('');
  assert.match(copy, /Installed the gh-stack extension/);
  assert.match(copy, /stacked pull requests/);
});

test('a failed install says so instead of reporting the attempt as an outcome', () => {
  // `install` is what it tried; `installed` is what worked. Claiming the first
  // is the second is the failure mode this whole ADR is about.
  const { tree } = render({ plan: autoInstallPlan(), installed: [] });
  const copy = text(tree.find((el) => el.props.className === 'tool-notice-msg')?.props.children).join('');
  assert.match(copy, /Could not install the gh-stack extension/);
  assert.doesNotMatch(copy, /^Installed/);
});

test('the command that ran stays inspectable, because "it installed something" is useless without what', () => {
  const { tree, writes } = render({ plan: autoInstallPlan(), installed: ['the gh-stack extension'] });
  const button = tree.find((el) => typeof el.props.onClick === 'function' && text(el.props.children).join('').includes('Show what ran'));
  assert.ok(button, 'the auto-install notice offers no way to see the command it ran');
  (button.props.onClick as () => void)();
  assert.deepEqual(writes, [TOOL_REQUIREMENTS.find((r) => r.id === 'gh-stack')!.installCommand]);
});

test('every arm planProvisioning can return renders — an unhandled arm is a crash, not a blank', () => {
  const plans = [
    planProvisioning([{ id: 'git', present: true }, { id: 'gh', present: true }, { id: 'gh-stack', present: true }]),
    autoInstallPlan(),
    planProvisioning(
      [{ id: 'git', present: true }, { id: 'gh', present: false }, { id: 'gh-stack', present: true }],
      { declined: new Set(), autoInstall: 'off' },
    ),
    planProvisioning([{ id: 'git', present: false }, { id: 'gh', present: true }, { id: 'gh-stack', present: true }]),
  ];
  assert.deepEqual(plans.map((p) => p.kind), ['ready', 'auto_install', 'offer', 'blocked']);
  for (const plan of plans) render({ plan });
});
