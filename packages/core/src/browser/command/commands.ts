/**
 * Layer 4 — the named command surface. One object both consumers (the Desktop
 * panel and the agent) call: action commands (tap/type/assertVisible/navigate/
 * setDevice) route through the injected `Backend`; query helpers (listScreens/
 * getScreen/findElement) read only the manifest, keeping the agent's context
 * small. The manifest is supplied as a getter so live re-extraction is reflected
 * without re-constructing the layer.
 */
import type { Backend } from './backend.js';
import { normalizeResult, errorResult } from './normalize.js';
import type { Command, Device, Screen, ScreenSummary, UiCommandResult, UiElement, UiMap } from '../types.js';
import { stripTrailingSlashes } from '../../util/trimEdges.js';

/** A resolved element reference for `findElement` / the agent. */
export interface ElementRef {
  id: string;
  testID: string;
  type: UiElement['type'];
  action: UiElement['action'];
  label?: string;
  screenId: string;
  screenTitle: string;
  route?: string | null;
}

export class CommandLayer {
  constructor(
    private readonly backend: Backend,
    private readonly manifest: () => UiMap | undefined,
    /** Optional dev-server base URL getter — when set, navigate produces an
     *  absolute URL (base + the screen's route); otherwise the bare route. */
    private readonly baseUrl?: () => string,
  ) {}

  /** Join the base URL with a screen route. Absolute routes pass through. */
  private resolveUrl(route?: string): string | undefined {
    const base = (this.baseUrl?.() ?? '').trim();
    if (route && /^https?:\/\//i.test(route)) return route;
    if (!route) return base || undefined;
    if (!base) return route;
    return stripTrailingSlashes(base) + (route.startsWith('/') ? route : `/${route}`);
  }

  // ---- query helpers (manifest-only, no backend) ----

  listScreens(): ScreenSummary[] {
    return (this.manifest()?.screens ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      route: s.route ?? null,
      elementCount: s.elements.length,
    }));
  }

  getScreen(screenId: string): Screen | undefined {
    return this.manifest()?.screens.find((s) => s.id === screenId);
  }

  findElement(query: string): ElementRef[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: ElementRef[] = [];
    for (const screen of this.manifest()?.screens ?? []) {
      for (const el of screen.elements) {
        const hay = `${el.testID} ${el.id} ${el.label ?? ''}`.toLowerCase();
        if (hay.includes(q)) {
          out.push({
            id: el.id,
            testID: el.testID,
            type: el.type,
            action: el.action,
            label: el.label,
            screenId: screen.id,
            screenTitle: screen.title,
            route: screen.route ?? null,
          });
        }
      }
    }
    return out;
  }

  // ---- action commands (route through the backend) ----

  async navigate(screenId: string): Promise<UiCommandResult> {
    const screen = this.getScreen(screenId);
    if (!screen) return errorResult('navigate', `unknown screen: ${screenId}`, { command: 'navigate', screen: screenId });
    return this.run(
      { kind: 'navigate', screen: screenId, url: this.resolveUrl(screen.route ?? undefined) },
      { command: 'navigate', screen: screenId },
    );
  }

  async tap(elementId: string): Promise<UiCommandResult> {
    return this.elementCommand('tap', elementId, (el, screen) => ({ kind: 'tap', testID: el.testID, screen: screen.id }));
  }

  async type(elementId: string, text: string): Promise<UiCommandResult> {
    return this.elementCommand('type', elementId, (el, screen) => ({ kind: 'type', testID: el.testID, text, screen: screen.id }));
  }

  async assertVisible(elementId: string): Promise<UiCommandResult> {
    return this.elementCommand('assertVisible', elementId, (el, screen) => ({ kind: 'assertVisible', testID: el.testID, screen: screen.id }));
  }

  async setDevice(device: Device): Promise<UiCommandResult> {
    return this.run({ kind: 'setDevice', device }, { command: 'setDevice' });
  }

  // ---- internals ----

  /** Locate an element by its stable id across all screens. */
  private locate(elementId: string): { el: UiElement; screen: Screen } | undefined {
    for (const screen of this.manifest()?.screens ?? []) {
      const el = screen.elements.find((e) => e.id === elementId || e.testID === elementId);
      if (el) return { el, screen };
    }
    return undefined;
  }

  private async elementCommand(
    command: string,
    elementId: string,
    build: (el: UiElement, screen: Screen) => Command,
  ): Promise<UiCommandResult> {
    const found = this.locate(elementId);
    if (!found) return errorResult(command, `unknown element: ${elementId}`, { command, testID: elementId });
    return this.run(build(found.el, found.screen), { command, testID: found.el.testID, screen: found.screen.id });
  }

  private async run(cmd: Command, fallback: { command: string; testID?: string; screen?: string }): Promise<UiCommandResult> {
    try {
      const raw = await this.backend.perform(cmd);
      return normalizeResult(raw, fallback);
    } catch (err) {
      return errorResult(fallback.command, err instanceof Error ? err.message : String(err), fallback);
    }
  }
}
