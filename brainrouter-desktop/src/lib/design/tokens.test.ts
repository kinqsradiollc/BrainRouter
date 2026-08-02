/**
 * ADR-027 D5 (P4-1) — the token system's invariants, as tests.
 *
 * A design system that is only a convention decays the first time someone is in
 * a hurry. These assert the three properties that make it a system: roles are
 * complete in every theme, the contrast a dense 13px scale depends on actually
 * holds, and the two themes stay structurally identical so a component written
 * against one cannot break in the other.
 */
import { describe, expect, it } from "vitest";
import {
  THEMES,
  TEXT_ON_SURFACE,
  RADIUS,
  TYPE_SCALE,
  cssVariables,
  cssRule,
  contrastRatio,
  parseHex,
  relativeLuminance,
  type ThemeName,
} from "./tokens";

const THEME_NAMES: ThemeName[] = ["light", "dark"];

describe("every role resolves in every theme", () => {
  it("the two themes have identical token shapes", () => {
    // A token present in dark but missing in light is invisible until someone
    // toggles the theme — the worst time to discover it.
    const shape = (t: ThemeName): string[] => Object.keys(cssVariables(t)).sort();
    expect(shape("light")).toEqual(shape("dark"));
  });

  it("no token is empty or malformed", () => {
    for (const theme of THEME_NAMES) {
      for (const [name, value] of Object.entries(cssVariables(theme))) {
        expect(value, `${theme} ${name}`).toBeTruthy();
        expect(value.trim(), `${theme} ${name}`).toBe(value);
      }
    }
  });

  it("every colour token is a parseable hex", () => {
    for (const theme of THEME_NAMES) {
      for (const [name, value] of Object.entries(cssVariables(theme))) {
        if (!value.startsWith("#")) continue;
        expect(() => parseHex(value), `${theme} ${name}`).not.toThrow();
      }
    }
  });
});

describe("contrast holds for a dense type scale", () => {
  it("primary text meets WCAG AA on its own surface", () => {
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      const ratio = contrastRatio(t.text.primary, t.surface[TEXT_ON_SURFACE.primary]);
      expect(ratio, `${theme} primary`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("muted text meets AA, because it carries real information", () => {
    // Timestamps and metadata are read, not decorative. Holding muted to the
    // same bar as primary is deliberate.
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      const ratio = contrastRatio(t.text.muted, t.surface[TEXT_ON_SURFACE.muted]);
      expect(ratio, `${theme} muted`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("subtle text clears the large-text floor at minimum", () => {
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      const ratio = contrastRatio(t.text.subtle, t.surface[TEXT_ON_SURFACE.subtle]);
      expect(ratio, `${theme} subtle`).toBeGreaterThanOrEqual(3);
    }
  });

  it("text on accent is legible against the accent", () => {
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      expect(contrastRatio(t.text.onAccent, t.accent), `${theme} onAccent`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it("status colours are distinguishable from the panel they appear on", () => {
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      for (const [name, value] of Object.entries(t.status)) {
        expect(contrastRatio(value, t.surface.panel), `${theme} ${name}`)
          .toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("the layer stack is actually layered", () => {
  it("the desk is visually distinct from a panel", () => {
    // The floating-panel shell only reads as floating if the desk differs.
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      expect(t.surface.desk, theme).not.toBe(t.surface.panel);
    }
  });

  it("borders are distinguishable from the surface they divide", () => {
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      expect(t.border.subtle, theme).not.toBe(t.surface.panel);
      expect(contrastRatio(t.border.strong, t.surface.panel), theme)
        .toBeGreaterThan(contrastRatio(t.border.subtle, t.surface.panel));
    }
  });
});

describe("scales are ordered", () => {
  it("radii increase monotonically", () => {
    const rem = (v: string): number => (v.endsWith("rem") ? parseFloat(v) : 0);
    expect(rem(RADIUS.sm)).toBeLessThan(rem(RADIUS.md));
    expect(rem(RADIUS.md)).toBeLessThan(rem(RADIUS.lg));
    expect(RADIUS.none).toBe("0");
  });

  it("type sizes increase monotonically and body is the D5 13px", () => {
    const px = (v: string): number => parseFloat(v);
    const order = [TYPE_SCALE.xs, TYPE_SCALE.sm, TYPE_SCALE.body, TYPE_SCALE.lg, TYPE_SCALE.xl, TYPE_SCALE.title];
    for (let i = 1; i < order.length; i += 1) {
      expect(px(order[i]), `${order[i]} after ${order[i - 1]}`).toBeGreaterThan(px(order[i - 1]));
    }
    expect(TYPE_SCALE.body).toBe("13px");
  });
});

describe("css generation", () => {
  it("emits sorted, prefixed custom properties", () => {
    const rule = cssRule("dark", ":root");
    expect(rule.startsWith(":root {")).toBe(true);
    const names = rule.split("\n").slice(1, -1).map((l) => l.trim().split(":")[0]);
    expect(names.every((n) => n.startsWith("--dls-"))).toBe(true);
    expect([...names]).toEqual([...names].sort());
  });

  it("camelCase roles become kebab-case properties", () => {
    expect(cssVariables("dark")).toHaveProperty("--dls-text-on-accent");
  });

  it("luminance is bounded and ordered", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
});
