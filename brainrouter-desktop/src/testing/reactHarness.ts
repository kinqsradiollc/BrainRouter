/**
 * The renderer's component-test harness: render a React tree under
 * `node --test`, drive it, and read what it actually rendered.
 *
 * ## What it owns
 *
 * Four things, and nothing about any particular feature:
 *
 * 1. Mounting a tree with `react-test-renderer` and disposing of it.
 * 2. `flush()` — let React's effects and the promises they started settle.
 * 3. Reading rendered TEXT out of an instance, whatever depth it is nested at.
 * 4. Finding and operating the controls a person would use: a button by its
 *    label, a field by its `aria-label` or its placeholder.
 *
 * ## Why it exists
 *
 * Because the desktop renderer had no component tests at all — no `*.test.tsx`
 * under `src/`, and a `test` glob (`src/**‍/*.test.ts`) that could not have run
 * one. What stood in for them was a file that read `MeetingsView.tsx` as text
 * and matched regexes over it, which can pin that a call is PRESENT and can
 * never pin that its RESULT is used. Three one-line deletions inside that
 * component each lose a real meeting and each left the whole suite green:
 * `liveRef.current = session`, `transcriptRef.current = folded.text`, and
 * `transcript: transcriptRef.current` at the call that posts it.
 *
 * ## Invariants
 *
 * 1. **Everything goes through `act`.** A state update outside it is applied
 *    after the assertion has already read the tree, which makes a passing test
 *    a coincidence and a failing one unreadable.
 * 2. **Queries read the OUTPUT, never the component.** `button('Create
 *    meeting')` matches the text a person sees. A test written against internal
 *    state would pass over a surface that renders none of it.
 * 3. **It knows nothing about meetings.** Fakes for a feature's ports belong in
 *    that feature's test, next to the assertion that depends on their shape.
 */
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactElement } from "react";

export interface Mounted {
  readonly root: ReactTestInstance;
  /** Run effects and let anything they awaited settle. */
  flush(): Promise<void>;
  /** Apply a synchronous interaction, then settle whatever it started. */
  act(run: () => void): Promise<void>;
  unmount(): void;
}

/**
 * Mount a tree and run its mount effects.
 *
 * Asynchronous because a component whose first paint kicks off a fetch has not
 * really rendered until that answer is in: returning before it would hand every
 * caller a loading state and make "assert what is on screen" mean the wrong
 * thing.
 */
export async function mount(element: ReactElement): Promise<Mounted> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => { renderer = TestRenderer.create(element); });
  const created = renderer;
  if (!created) throw new Error("The test renderer produced no tree.");
  /**
   * A macrotask turn inside `act`, twice.
   *
   * A microtask tick is not enough: these surfaces chain awaits (press Stop →
   * the recorder's `onstop` → the final write → the IPC → read the record back),
   * and settling only the first link leaves the assertion reading a half-applied
   * interaction. A `setTimeout(0)` drains the whole microtask queue; the second
   * pass covers an effect that a state change from the first one scheduled.
   */
  const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 2; pass += 1) {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    }
  };
  await flush();
  return {
    root: created.root,
    flush,
    act: async (run) => { await act(async () => { run(); }); await flush(); },
    unmount: () => { act(() => { created.unmount(); }); },
  };
}

/** Every string rendered under this instance, joined — what a person reads there. */
export function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((child) => textOf(child as ReactTestInstance | string)).join("");
}

/** The whole tree's visible text. Used for "does this surface say X at all". */
export function screenText(root: ReactTestInstance): string {
  return textOf(root);
}

function labelled(instance: ReactTestInstance, label: string): boolean {
  const props = instance.props as { "aria-label"?: unknown; placeholder?: unknown };
  return props["aria-label"] === label || props.placeholder === label;
}

/**
 * The buttons whose label CONTAINS this text.
 *
 * Contains rather than equals because real labels carry state with them — "▶
 * Play", "Creating & summarizing…" — and a test that had to spell the whole
 * string would be re-asserting the busy text it is not about.
 */
export function buttons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAllByType("button").filter((node) => textOf(node).includes(label) || labelled(node, label));
}

/** The one button with this label. Throws when there are none or several, because both are the test being wrong. */
export function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = buttons(root, label);
  if (found.length !== 1) {
    throw new Error(`Expected exactly one button matching "${label}", found ${found.length}.`);
  }
  return found[0]!;
}

/** Is there a button with this label at all — for "the control is gone", which is a different claim from "disabled". */
export function hasButton(root: ReactTestInstance, label: string): boolean {
  return buttons(root, label).length > 0;
}

export function isDisabled(instance: ReactTestInstance): boolean {
  return Boolean((instance.props as { disabled?: unknown }).disabled);
}

/**
 * Press a button the way the surface allows.
 *
 * A `disabled` control is REFUSED here rather than clicked, because a browser
 * refuses it too: a test that reached past the attribute would be asserting
 * about a handler no user can reach, and the whole point of several of these
 * guards is that the pixel and the rule agree.
 */
export async function press(mounted: Mounted, label: string): Promise<void> {
  const target = button(mounted.root, label);
  if (isDisabled(target)) throw new Error(`The "${label}" button is disabled and cannot be pressed.`);
  const onClick = (target.props as { onClick?: (event: unknown) => void }).onClick;
  if (!onClick) throw new Error(`The "${label}" button has no click handler.`);
  await mounted.act(() => onClick({}));
}

/** A field by its `aria-label` or placeholder — the two things a person or a screen reader goes by. */
export function field(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = [...root.findAllByType("input"), ...root.findAllByType("textarea")]
    .filter((node) => labelled(node, label));
  if (found.length !== 1) {
    throw new Error(`Expected exactly one field labelled "${label}", found ${found.length}.`);
  }
  return found[0]!;
}

export function valueOf(instance: ReactTestInstance): string {
  const value = (instance.props as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

/** Type into a field through its own `onChange`, as the DOM would deliver it. */
export async function typeInto(mounted: Mounted, label: string, value: string): Promise<void> {
  const target = field(mounted.root, label);
  const onChange = (target.props as { onChange?: (event: unknown) => void }).onChange;
  if (!onChange) throw new Error(`The field labelled "${label}" has no change handler.`);
  await mounted.act(() => onChange({ target: { value }, currentTarget: { value } }));
}
