/**
 * Shared control-primitive class composition (Button / Badge consolidation).
 *
 * The desktop panels had ~50 hand-written `<button className="wt-btn …">` and
 * `<span className="req-link-chip">` call sites. These pure helpers centralize
 * the class strings so the <Button>/<Chip> primitives (and any future restyle)
 * change them in ONE place. The emitted class names are BYTE-IDENTICAL to the
 * old inline strings — this is a behavior-preserving consolidation, no visual
 * change — so it's unit-testable without a DOM.
 */

/** Button visual variants — each maps to the existing `.wt-btn[.variant]` CSS. */
export type ButtonVariant = 'default' | 'primary' | 'primary-ghost' | 'danger';

/**
 * Compose a `.wt-btn` button class. `default` is the bare `wt-btn`; other
 * variants append their modifier (matching the existing CSS selectors); an
 * optional `extra` class is appended last. Falsy parts are dropped.
 */
export function buttonClass(variant: ButtonVariant = 'default', extra?: string): string {
  return ['wt-btn', variant === 'default' ? '' : variant, extra ?? ''].filter(Boolean).join(' ');
}

/** Compose a `.req-link-chip` badge class (+ optional extra). */
export function chipClass(extra?: string): string {
  return ['req-link-chip', extra ?? ''].filter(Boolean).join(' ');
}
