/**
 * The BrainRouter guilloché mark as a self-contained SVG markup string — the
 * same geometry as components/BrainRouterLogo, but emitted as a string so it
 * can be composed into exported poster SVGs (and reused as a faint backdrop
 * motif). No gradients/defs needed: solid accent + a white highlight, so the
 * markup survives SVG→PNG rasterization intact.
 */

const PRIMARY = Array.from({ length: 6 }, (_, i) => (i * 60 * Math.PI) / 180);
const OFFSET = Array.from({ length: 6 }, (_, i) => ((i * 60 + 30) * Math.PI) / 180);

export function guillocheMarkup(opts: {
  cx: number;
  cy: number;
  /** scale factor; the lattice has radius 44 in local units (Ø 88). */
  scale: number;
  accent: string;
  withCore?: boolean;
  withNodes?: boolean;
  opacity?: number;
  strokeWidth?: number;
}): string {
  const { cx, cy, scale, accent, withCore = true, withNodes = true, opacity = 1, strokeWidth = 1 } = opts;
  const p = (a: number, d: number) => `${(Math.cos(a) * d).toFixed(2)} ${(Math.sin(a) * d).toFixed(2)}`;
  let s = `<g transform="translate(${cx} ${cy}) scale(${scale})" opacity="${opacity}">`;
  s += `<circle r="44" fill="none" stroke="${accent}" stroke-width="${strokeWidth}" stroke-opacity="0.32"/>`;
  for (const a of PRIMARY) {
    const [x, y] = p(a, 22).split(" ");
    s += `<circle cx="${x}" cy="${y}" r="22" fill="none" stroke="${accent}" stroke-width="${strokeWidth}" stroke-opacity="0.6"/>`;
  }
  for (const a of OFFSET) {
    const [x, y] = p(a, 22).split(" ");
    s += `<circle cx="${x}" cy="${y}" r="22" fill="none" stroke="${accent}" stroke-width="${(strokeWidth * 0.75).toFixed(2)}" stroke-opacity="0.32"/>`;
  }
  if (withNodes) {
    for (const a of PRIMARY) {
      const [x, y] = p(a, 44).split(" ");
      s += `<circle cx="${x}" cy="${y}" r="2.4" fill="${accent}"/>`;
    }
  }
  if (withCore) {
    s += `<circle r="7" fill="${accent}"/>`;
    s += `<circle r="7" fill="none" stroke="#fff" stroke-opacity="0.25" stroke-width="0.8"/>`;
    s += `<circle cx="-2.3" cy="-2.8" r="3" fill="#fff" fill-opacity="0.22"/>`;
  }
  s += `</g>`;
  return s;
}
