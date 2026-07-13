/**
 * Manifest diff — what changed between two `UiMap`s, so the panel can highlight
 * new/removed/changed testIDs after a save (the extractor's "emit + diff" output).
 * Elements are keyed by `screenId:testID`; "changed" means the inferred type or
 * action moved.
 */
import type { UiMap, UiElement } from '../types.js';

export interface ManifestDiff {
  addedElements: string[];
  removedElements: string[];
  changedElements: string[];
  addedScreens: string[];
  removedScreens: string[];
}

function elementKey(screenId: string, testID: string): string {
  return `${screenId}:${testID}`;
}

function indexElements(map: UiMap | undefined): Map<string, UiElement> {
  const out = new Map<string, UiElement>();
  for (const screen of map?.screens ?? []) {
    for (const el of screen.elements) out.set(elementKey(screen.id, el.testID), el);
  }
  return out;
}

export function diffManifests(prev: UiMap | undefined, next: UiMap): ManifestDiff {
  const prevEls = indexElements(prev);
  const nextEls = indexElements(next);

  const addedElements: string[] = [];
  const removedElements: string[] = [];
  const changedElements: string[] = [];

  for (const [key, el] of nextEls) {
    const before = prevEls.get(key);
    if (!before) addedElements.push(key);
    else if (before.type !== el.type || before.action !== el.action) changedElements.push(key);
  }
  for (const key of prevEls.keys()) {
    if (!nextEls.has(key)) removedElements.push(key);
  }

  const prevScreens = new Set((prev?.screens ?? []).map((s) => s.id));
  const nextScreens = new Set(next.screens.map((s) => s.id));
  const addedScreens = [...nextScreens].filter((id) => !prevScreens.has(id));
  const removedScreens = [...prevScreens].filter((id) => !nextScreens.has(id));

  return { addedElements, removedElements, changedElements, addedScreens, removedScreens };
}
