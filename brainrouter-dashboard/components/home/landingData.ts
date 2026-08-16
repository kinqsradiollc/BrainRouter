/**
 * Scroll-reveal variants shared by the homepage slide machinery.
 *
 * A slide's outer element is the `whileInView` trigger and uses `slideStagger`;
 * its direct children use `slideChild` and INHERIT the hidden/show label — they
 * must not declare their own `whileInView`, or the framer variant tree will
 * ignore it. Nest another `slideStagger` to cascade a sub-group.
 *
 * Keep this file to variants that something renders. A variant nobody applies
 * is the same defect as a component nobody mounts.
 */
export const slideStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.04 } }
} as const;

export const slideChild = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 200, damping: 24 } }
} as const;
