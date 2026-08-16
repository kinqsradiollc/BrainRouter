"use client";

import { motion } from "framer-motion";

import { slideChild } from "./landingData";

/**
 * Consistent slide heading: a mono eyebrow, a display title, and an optional
 * lede. Renders as a single `slideChild` variant node, so it reveals in step
 * with its parent slide's stagger (do not give it its own whileInView).
 *
 * `titleId` is for sections that label themselves with this heading via
 * aria-labelledby — the heading is the section's real name, so it should be
 * the thing the section points at.
 */
export function SlideHeading({
  eyebrow,
  title,
  lede,
  align = "left",
  titleId,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  align?: "left" | "center";
  titleId?: string;
}) {
  return (
    <motion.div
      variants={slideChild}
      className="slide-heading"
      data-align={align}
    >
      <span className="slide-heading-eyebrow">{eyebrow}</span>
      <h2 id={titleId}>{title}</h2>
      {lede && <p>{lede}</p>}
    </motion.div>
  );
}
