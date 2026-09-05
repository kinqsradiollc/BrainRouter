/**
 * The design-detector rule catalogue (ADR-056 D-B1).
 *
 * Authored in-house from the field's consensus about what makes a generated
 * interface look generated: three categories, one stable id per rule, a
 * severity, and the guideline the finding cites. The catalogue is versioned
 * like the tool catalog — `DESIGN_RULES_VERSION` bumps when a rule is added,
 * removed, or changes meaning — and rendered into a drift-checked document so
 * a rule cannot change without the change being visible.
 *
 *   - `slop`          — tells that an interface was assembled from defaults;
 *   - `quality`       — measurable defects (contrast, sizes, semantics, motion);
 *   - `design-system` — drift from the workspace's own `design.md` tokens.
 *
 * `advisory` rules are reported but never counted as failures: they flag a
 * pattern worth a look, not a defect.
 */

export const DESIGN_RULES_VERSION = '1.0.0';

export type DesignRuleCategory = 'slop' | 'quality' | 'design-system';
export type DesignRuleSeverity = 'error' | 'warning' | 'info';

export interface DesignRule {
  id: string;
  category: DesignRuleCategory;
  severity: DesignRuleSeverity;
  /** Reported, never a failure. */
  advisory?: boolean;
  name: string;
  description: string;
  /** The guideline a finding cites — the sentence a reviewer would write. */
  guideline: string;
}

export const DESIGN_RULES: readonly DesignRule[] = [
  // ── slop ──────────────────────────────────────────────────────────────────
  { id: 'side-stripe-border', category: 'slop', severity: 'warning', name: 'Side-stripe accent border', description: 'A thick coloured border on one side of a card, list item, or callout.', guideline: 'Colour belongs to meaning, not to a stripe; remove the accent or make the whole surface carry it.' },
  { id: 'gradient-text', category: 'slop', severity: 'warning', name: 'Gradient text', description: 'Text filled with a gradient via background-clip.', guideline: 'Emphasis comes from weight or size; text is solid.' },
  { id: 'ai-palette', category: 'slop', severity: 'warning', name: 'Default AI palette', description: 'Purple-to-blue/violet gradients or cyan-on-near-black as the accent.', guideline: 'Choose a palette the product owns; the violet gradient and cyan-on-black are the defaults every generator reaches for.' },
  { id: 'nested-cards', category: 'slop', severity: 'warning', name: 'Cards inside cards', description: 'A bordered/shadowed card containing another card.', guideline: 'One container per idea; a card inside a card is structure standing in for hierarchy.' },
  { id: 'identical-card-grid', category: 'slop', severity: 'info', advisory: true, name: 'Identical card grid', description: 'Three or more sibling cards with the same icon + heading + paragraph shape.', guideline: 'A grid of identical cards is the lazy section; vary the structure or drop the cards.' },
  { id: 'hero-metric', category: 'slop', severity: 'info', advisory: true, name: 'Hero-metric template', description: 'Big number with a small label repeated as a stats row.', guideline: 'Numbers earn size when they carry a decision; a row of decorated metrics is a template.' },
  { id: 'overused-font', category: 'slop', severity: 'info', name: 'Overused typeface', description: 'Inter, Roboto, Arial, or the system default as the only display face.', guideline: 'Pick a face that gives the interface a voice; the default sans is invisible.' },
  { id: 'flat-type-hierarchy', category: 'slop', severity: 'warning', name: 'Flat type hierarchy', description: 'Heading sizes within 1.25× of body size at every step.', guideline: 'Give the scale at least one decisive step so the page has a hierarchy.' },
  { id: 'glow-halo', category: 'slop', severity: 'warning', name: 'Glow halo', description: 'A zero-offset coloured box-shadow used as decoration.', guideline: 'Depth has an offset and a soft blur; a coloured halo is ornament.' },
  { id: 'bounce-easing', category: 'slop', severity: 'info', name: 'Bounce / elastic easing', description: 'A transition or animation with an overshooting cubic-bezier or bounce keyframes.', guideline: 'Motion eases out from an already-visible state; bouncing reads dated.' },
  { id: 'pulsing-dot', category: 'slop', severity: 'info', name: 'Infinite pulse', description: 'An infinitely repeating pulse/blink animation on a decorative element.', guideline: 'One authored moment, finite, reader-controlled; nothing pulses forever.' },
  { id: 'marquee', category: 'slop', severity: 'warning', name: 'Marquee', description: 'A marquee element or an infinite horizontal scroll animation.', guideline: 'Content that moves cannot be read; remove the marquee.' },
  { id: 'eyebrow-label', category: 'slop', severity: 'info', name: 'Eyebrow above heading', description: 'A small uppercase label immediately above a heading.', guideline: 'The heading carries its own weight; delete the label above it.' },
  { id: 'numbered-sections', category: 'slop', severity: 'info', advisory: true, name: 'Numbered section labels', description: '"01 / 02 / 03" markers on sections that are not a sequence.', guideline: 'Number sections only when the order itself is information.' },
  { id: 'icon-tile-stack', category: 'slop', severity: 'info', advisory: true, name: 'Icon tile above heading', description: 'A rounded-square icon tile stacked above a heading in a card.', guideline: 'The icon-tile-plus-heading stack is the most recognisable generated pattern; let the heading lead.' },
  { id: 'buzzword-copy', category: 'slop', severity: 'info', name: 'Marketing buzzwords', description: 'Copy leaning on "seamless", "unleash", "supercharge", "next-level", "revolutionize", "effortlessly".', guideline: 'Say what the product does in the product\'s own words.' },
  { id: 'em-dash-overuse', category: 'slop', severity: 'info', advisory: true, name: 'Em-dash cadence', description: 'More than one em dash per forty words of visible copy.', guideline: 'The em-dash cadence is a generator tell; use full stops.' },
  // ── quality ───────────────────────────────────────────────────────────────
  { id: 'gray-on-color', category: 'quality', severity: 'warning', name: 'Gray text on a coloured surface', description: 'Neutral gray text over a chromatic background.', guideline: 'On a coloured surface, tint secondary text from the hue or the foreground; never gray.' },
  { id: 'low-contrast', category: 'quality', severity: 'error', name: 'Low contrast', description: 'Text/background contrast under 4.5:1 (3:1 for large text) where both colours are resolvable.', guideline: 'Body text ≥ 4.5:1, large text ≥ 3:1 (WCAG AA).' },
  { id: 'tiny-text', category: 'quality', severity: 'warning', name: 'Tiny text', description: 'Body-copy font-size under 12px.', guideline: 'Body text is at least 12px; 14–16px reads.' },
  { id: 'tight-leading', category: 'quality', severity: 'warning', name: 'Tight leading', description: 'Body-copy line-height under 1.2.', guideline: 'Body line-height 1.4–1.6.' },
  { id: 'justified-text', category: 'quality', severity: 'warning', name: 'Justified text', description: 'text-align: justify on body copy.', guideline: 'Ragged-right; justified text rivers on screens.' },
  { id: 'all-caps-body', category: 'quality', severity: 'warning', name: 'All-caps body copy', description: 'text-transform: uppercase on a paragraph-length element.', guideline: 'Uppercase is for short labels; body copy keeps its case.' },
  { id: 'wide-tracking', category: 'quality', severity: 'info', name: 'Wide letter-spacing on body', description: 'letter-spacing over 0.05em on lowercase body copy.', guideline: 'Tracking opens small caps and labels; body copy runs tight.' },
  { id: 'skipped-heading', category: 'quality', severity: 'warning', name: 'Skipped heading level', description: 'A heading level more than one step below its predecessor.', guideline: 'Headings step one level at a time; the outline is the document.' },
  { id: 'missing-alt', category: 'quality', severity: 'error', name: 'Image without alt', description: 'An <img> with no alt attribute.', guideline: 'Every image has alt text (empty for decoration).' },
  { id: 'unlabelled-control', category: 'quality', severity: 'error', name: 'Unlabelled form control', description: 'An input, select, or textarea with no label, aria-label, aria-labelledby, or placeholder-only labelling.', guideline: 'Every control has a visible label or an accessible name.' },
  { id: 'focus-outline-removed', category: 'quality', severity: 'error', name: 'Focus outline removed', description: 'outline: none / 0 without a :focus-visible rule that restores a visible focus style.', guideline: 'Keyboard focus is always visible; replace the outline, never remove it.' },
  { id: 'reduced-motion-ignored', category: 'quality', severity: 'warning', name: 'Motion without a reduced-motion path', description: 'Animations or transitions with no prefers-reduced-motion rule anywhere.', guideline: 'Every animation has a prefers-reduced-motion alternative that keeps the state change.' },
  { id: 'small-touch-target', category: 'quality', severity: 'warning', name: 'Small touch target', description: 'A button or link with an explicit height or min-height under 44px and no padding to make up for it.', guideline: 'Interactive targets are at least 44×44 CSS px.' },
  { id: 'fixed-width-layout', category: 'quality', severity: 'warning', name: 'Fixed pixel width', description: 'A layout container with a fixed width over 960px and no max-width.', guideline: 'Layouts flow; use max-width and let the container shrink.' },
  { id: 'inline-color-literal', category: 'quality', severity: 'info', advisory: true, name: 'Colour literal in markup', description: 'A hex/rgb colour written inline in a style attribute.', guideline: 'Colours come from tokens, not from the element.' },
  // ── design-system ─────────────────────────────────────────────────────────
  { id: 'design-system-font', category: 'design-system', severity: 'warning', name: 'Font outside the design system', description: 'A font-family not declared in design.md typography tokens.', guideline: 'The typefaces in design.md are the typefaces; add a token or use one.' },
  { id: 'design-system-color', category: 'design-system', severity: 'warning', name: 'Colour outside the design system', description: 'A literal colour not declared in design.md colour tokens.', guideline: 'The palette in design.md is the palette; add a token or use one.' },
  { id: 'design-system-radius', category: 'design-system', severity: 'info', name: 'Radius outside the design system', description: 'A border-radius not declared in design.md rounded tokens.', guideline: 'Radii come from the rounded scale in design.md.' },
];

export const DESIGN_RULE_BY_ID: ReadonlyMap<string, DesignRule> = new Map(DESIGN_RULES.map((r) => [r.id, r]));

export function isDesignRuleId(v: unknown): v is string {
  return typeof v === 'string' && DESIGN_RULE_BY_ID.has(v);
}

/** Faces so common on generated pages that they carry no identity. */
export const OVERUSED_FONTS = ['inter', 'roboto', 'arial', 'helvetica', 'system-ui', '-apple-system', 'segoe ui', 'plus jakarta sans', 'space grotesk', 'geist', 'fraunces'];

/** Copy that says nothing. Matched as whole words, case-insensitive. */
export const BUZZWORDS = ['seamless', 'seamlessly', 'unleash', 'supercharge', 'supercharged', 'next-level', 'revolutionize', 'revolutionary', 'effortlessly', 'game-changing', 'cutting-edge', 'elevate your', 'empower your', 'unlock the power'];
