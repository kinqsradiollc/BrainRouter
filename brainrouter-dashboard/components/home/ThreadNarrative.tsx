"use client";

/**
 * ThreadNarrative — the homepage's argument, as motion.
 *
 * Six stages of the product loop share one sticky stage. As you scroll, the
 * surface behind the work changes — Planner, Meetings, Notes, the workbench,
 * Reviews, Knowledge — while the work item itself is a SINGLE DOM node that
 * never unmounts. That is the whole point and the reason the card lives
 * outside the scene list: "keep the thread" is not a claim the copy makes, it
 * is a thing the page does.
 *
 * Reduced motion is handled in CSS, not by branching the tree: the runway
 * collapses, the sticky stage becomes static, and the six scenes stack into
 * ordinary flow with every transform neutralised (see `.thread-*` in
 * globals.css). The JS side only stops passing motion values. Because the tree
 * is identical either way there is nothing for hydration to disagree about.
 *
 * Off-screen scenes are `inert` so a keyboard user cannot tab into a scene
 * that is invisible; under reduced motion every scene is visible, so nothing
 * is inert.
 */

import { useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";

import { BorderBeam } from "./BorderBeam";
import { Citation } from "./Citation";
import { SlideHeading } from "./SlideHeading";
import { SurfaceChrome } from "./SurfaceChrome";
import { ThreadRail } from "./ThreadRail";
import { LOOP_STAGES, THREAD, type LoopStage } from "./loopStory";
import { slideStagger } from "./landingData";

const EASE = [0.16, 1, 0.3, 1] as const;
/** Cross-fade half-width, in units of overall scroll progress. */
const BLEND = 0.035;

function Scene({
  stage,
  index,
  count,
  progress,
  animate,
  hidden,
  linkSlot,
}: {
  stage: LoopStage;
  index: number;
  count: number;
  progress: MotionValue<number>;
  animate: boolean;
  hidden: boolean;
  linkSlot: React.ReactNode;
}) {
  const start = index / count;
  const end = (index + 1) / count;
  // The scenes are stacked in one place, so the fades are SEQUENCED rather than
  // overlapped: this one is gone by `end`, and the next only begins there. They
  // used to share the window [end - BLEND, end + BLEND], which put both at half
  // opacity at its midpoint — two headlines and two paragraphs superimposed and
  // neither of them readable. A crossfade is only free when the things crossing
  // are pictures; with body copy it is just text on text.
  // The first scene is already on screen at progress 0 and the last one must
  // not fade out before the runway ends, so their outer stops sit off-domain.
  const enterFrom = index === 0 ? -1 : start;
  const enterTo = index === 0 ? -0.5 : start + BLEND;
  const exitFrom = index === count - 1 ? 1.5 : end - BLEND;
  const exitTo = index === count - 1 ? 2 : end;
  const opacity = useTransform(progress, [enterFrom, enterTo, exitFrom, exitTo], [0, 1, 1, 0]);
  const y = useTransform(progress, [start, end], [20, -20]);

  return (
    <motion.article
      className="thread-scene"
      data-tone={stage.tone}
      style={animate ? { opacity, y } : undefined}
      inert={hidden || undefined}
    >
      <div className="thread-scene-copy">
        <span className="thread-scene-ordinal">{stage.ordinal}</span>
        <h3>{stage.title}</h3>
        <p>{stage.copy}</p>
        <p className="thread-scene-hands"><span aria-hidden>↳</span> {stage.hands}</p>
        {linkSlot}
      </div>
      <div className="thread-scene-surface">
        <SurfaceChrome stage={stage} />
      </div>
    </motion.article>
  );
}

export function ThreadNarrative({ renderLink }: { renderLink: (stage: LoopStage) => React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  const animate = !reduceMotion;
  const runwayRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: runwayRef, offset: ["start start", "end end"] });
  const progress = useSpring(scrollYProgress, { stiffness: 150, damping: 30, mass: 0.28 });
  const [active, setActive] = useState(0);
  const count = LOOP_STAGES.length;

  useMotionValueEvent(progress, "change", (value) => {
    // With the choreography off every scene is on screen at once, so there is
    // no "active" one to track and no reason to re-render on scroll.
    if (!animate) return;
    const next = Math.min(count - 1, Math.max(0, Math.floor(value * count)));
    setActive((current) => (current === next ? current : next));
  });

  const stage = LOOP_STAGES[active] ?? LOOP_STAGES[0];

  return (
    <section className="thread-narrative" id="loop" aria-labelledby="thread-heading">
      <motion.div
        className="thread-intro"
        variants={slideStagger}
        initial={reduceMotion ? false : "hidden"}
        whileInView="show"
        viewport={{ once: true, amount: 0.5 }}
      >
        <SlideHeading
          titleId="thread-heading"
          eyebrow="Plan · Meet · Write · Build · Verify · Know"
          title={<>Six things happen to one piece of work. It stays the same piece of work.</>}
          lede="Watch a single item cross the whole loop. The surface around it changes at every stage; the item, its owner and its evidence do not."
        />
      </motion.div>

      <div className="thread-runway" ref={runwayRef}>
        <div className="thread-stage">
          <ThreadRail progress={progress} active={active} animate={animate} />

          <div className="thread-scenes">
            {LOOP_STAGES.map((item, index) => (
              <Scene
                key={item.id}
                stage={item}
                index={index}
                count={count}
                progress={progress}
                animate={animate}
                hidden={animate && index !== active}
                linkSlot={renderLink(item)}
              />
            ))}
          </div>

          {/* The thread. One node, mounted once, carried through every scene. */}
          <div className="thread-carry">
            <article className="thread-card">
              <span className="thread-card-label">The thread</span>
              <strong>{THREAD.title}</strong>
              <span className="thread-card-state" aria-hidden>
                <AnimatePresence initial={false} mode="wait">
                  <motion.span
                    key={stage.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 7 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -7 }}
                    transition={{ duration: 0.22, ease: EASE }}
                  >
                    <i />{stage.routeLabel} · {THREAD.states[stage.id]}
                  </motion.span>
                </AnimatePresence>
              </span>
              {/* Always in the accessibility tree; only drawn when the scroll
                  choreography is off, where it replaces the live state line. */}
              <ol className="thread-card-log">
                {LOOP_STAGES.map((item) => (
                  <li key={item.id}><b>{item.routeLabel}</b>{THREAD.states[item.id]}</li>
                ))}
              </ol>
              <BorderBeam duration={9} />
            </article>
          </div>
        </div>
      </div>

      <Citation
        label="Every stage above is a route in this product"
        links={LOOP_STAGES.map((item) => ({ short: item.routeLabel, href: item.route }))}
      />
    </section>
  );
}
