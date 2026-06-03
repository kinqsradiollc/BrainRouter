"use client";

import { motion, useScroll, useSpring, useTransform } from "framer-motion";

/**
 * ScrollBeam — a fixed Signal "beam" down the left edge that follows scroll: a
 * faint full-height track, a gradient fill that grows top→bottom with scroll
 * progress, and a soft glowing head riding the leading edge. Reads as a light
 * beam tracing your position through the page. transform/opacity only.
 */
export function ScrollBeam() {
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30, restDelta: 0.001 });
  const headTop = useTransform(progress, [0, 1], ["0%", "100%"]);

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: 2,
        zIndex: 60,
        pointerEvents: "none",
        background: "var(--border-dim)",
      }}
    >
      {/* fill that grows with scroll */}
      <motion.div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "100%",
          transformOrigin: "top",
          scaleY: progress,
          background: "linear-gradient(180deg, transparent, var(--accent) 30%, var(--accent))",
          opacity: 0.7,
        }}
      />
      {/* glowing head riding the leading edge */}
      <motion.div
        style={{
          position: "absolute",
          left: -3,
          top: headTop,
          width: 8,
          height: 8,
          marginTop: -4,
          borderRadius: 9999,
          background: "var(--accent)",
          boxShadow: "0 0 12px 2px var(--accent)",
        }}
      />
    </div>
  );
}
