"use client";

/**
 * ThreadRail — the six loop words, with the thread drawn through them.
 *
 * The rail is the page's one persistent orientation device: the fill grows and
 * the marker travels as the narrative's scroll progress advances, so the loop
 * is visibly one continuous line rather than six separate claims. Only
 * `transform` animates (a scaled track fill and a translated marker).
 *
 * Under reduced motion the moving parts are hidden by CSS and the list stands
 * on its own as an ordinary ordered list, which is what it always was.
 */

import { motion, useTransform, type MotionValue } from "framer-motion";

import { LOOP_STAGES } from "./loopStory";

export function ThreadRail({
  progress,
  active,
  animate,
}: {
  progress: MotionValue<number>;
  active: number;
  animate: boolean;
}) {
  const count = LOOP_STAGES.length;
  // Cell centres, so the marker sits on step i when scene i is on screen
  // rather than only reaching the last step at the very end of the runway.
  const markerX = useTransform(progress, [0.5 / count, (count - 0.5) / count], ["0%", `${(count - 1) * 100}%`]);
  const fill = useTransform(progress, [0, 1], [1 / count, 1]);

  return (
    <div className="thread-rail">
      <div className="thread-rail-track" aria-hidden>
        <motion.i style={animate ? { scaleX: fill } : undefined} />
      </div>
      <motion.span className="thread-rail-marker" aria-hidden style={animate ? { x: markerX } : undefined} />
      <ol className="thread-rail-steps">
        {LOOP_STAGES.map((stage, index) => (
          <li key={stage.id} data-tone={stage.tone} aria-current={animate && index === active ? "step" : undefined}>
            <b>{stage.ordinal}</b>
            <span>{stage.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
