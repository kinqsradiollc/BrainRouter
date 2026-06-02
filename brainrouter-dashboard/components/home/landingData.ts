/**
 * Landing-page animation variants shared by the Home slide deck.
 *
 *  - itemVariants / pulseVariants — hero entrance + the ambient status pulse.
 *  - slideStagger / slideChild — scroll-reveal orchestration for the slides
 *    (see SlideHeading and the Slide* components). A slide <section> is the
 *    whileInView trigger and uses slideStagger; its direct children use
 *    slideChild and INHERIT the hidden/show label — they must not declare
 *    their own whileInView, or the framer variant tree will ignore it. Nest
 *    another slideStagger to cascade a sub-group. Continuous ambient loops
 *    inside children use `animate` so they run independently of the reveal.
 */
export const itemVariants = {
  hidden: { opacity: 0, y: 25 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 220, damping: 22 }
  }
} as const;

export const pulseVariants = {
  animate: {
    scale: [1, 1.04, 1],
    opacity: [0.6, 1, 0.6],
    transition: {
      duration: 2.5,
      repeat: Infinity,
      ease: "easeInOut" as const
    }
  }
};

export const slideStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.04 } }
} as const;

export const slideChild = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 200, damping: 24 } }
} as const;
