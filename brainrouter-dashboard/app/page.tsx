"use client";

/**
 * The public homepage.
 *
 * BrainRouter is one workspace a whole team works in, and engineering is its
 * deepest surface rather than its frame. The page is therefore built as a
 * narrative through the product's own loop — Plan · Meet · Write · Build ·
 * Verify · Know — with recall as the sixth stage that makes the other five
 * survive contact with each other, not as the headline.
 *
 * Two rules govern edits here:
 *  - Every surface named on this page is a route in `app/` with a working
 *    feature behind it. See `components/home/loopStory.ts`.
 *  - Every animation collapses under `prefers-reduced-motion`. The hero and the
 *    reveals gate on `useReducedMotion`; the scroll narrative collapses in CSS.
 */

import Link from "next/link";
import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion";

import { PremiumButton } from "../components/PremiumButton";
import { ProductOrbit } from "../components/ProductOrbit";
import { ThreadNarrative } from "../components/home/ThreadNarrative";
import { LOOP_STAGES, type LoopStage } from "../components/home/loopStory";
import { PRODUCT_CAPABILITIES, PRODUCT_SURFACES } from "../lib/homeProductStory";
import { STATIC_PRESENTATION } from "../lib/presentation";

const EASE = [0.16, 1, 0.3, 1] as const;

export default function HomePage() {
  const reduceMotion = useReducedMotion();
  const revealInitial = reduceMotion ? false : { opacity: 0, y: 24 };
  // Cinematic hero staging: kicker → headline lines → actions → proof, while
  // the operations scene behind them powers on. No-ops under reduced motion.
  const stage = (delay: number) => reduceMotion ? {} : {
    initial: { opacity: 0, y: 26, filter: "blur(6px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: .65, delay, ease: EASE },
  };

  // Page progress, and a film-style exit: the foreground title card rises away
  // while the scene behind it slowly zooms in (backgrounds move less than
  // foregrounds). Inert under reduced motion.
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 170, damping: 30, mass: 0.3 });
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroCopyY = useTransform(heroProgress, [0, 1], [0, -80]);
  const heroVisualY = useTransform(heroProgress, [0, 1], [0, 46]);
  const heroVisualScale = useTransform(heroProgress, [0, 1], [1, 1.08]);

  // Presentation-only builds have no dashboard behind the routes, so a stage's
  // surface is named but not linked rather than linked into a dead end.
  const stageLink = (item: LoopStage) => STATIC_PRESENTATION
    ? <span className="thread-scene-link thread-scene-link--static">{item.routeLabel}</span>
    : (
      <Link className="thread-scene-link" href={item.route}>
        Open {item.routeLabel} <span aria-hidden>→</span>
      </Link>
    );

  return (
    <div className="platform-landing">
      <motion.div className="platform-scroll-progress" style={reduceMotion ? undefined : { scaleX: progress }} aria-hidden />

      {/* Immersive hero — the operations scene IS the viewport; copy floats on
          it like a title card and rises away on exit. */}
      <motion.section ref={heroRef} className="platform-hero-cine" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .6 }}>
        <motion.div className="platform-hero-cine-scene" aria-hidden style={reduceMotion ? undefined : { y: heroVisualY, scale: heroVisualScale }}>
          <ProductOrbit immersive />
        </motion.div>
        <div className="platform-hero-cine-grade" aria-hidden />
        <motion.div className="platform-hero-cine-fg" style={reduceMotion ? undefined : { y: heroCopyY }}>
          <motion.span className="platform-kicker" {...stage(0)}><i /> One workspace your agents actually work in</motion.span>
          <h1>
            <motion.span className="platform-hero-line" {...stage(.08)}>Plan the day, run the meeting,</motion.span>
            <motion.span className="platform-hero-line" {...stage(.2)}>write the doc, ship the change —</motion.span>
            <motion.span className="platform-hero-line" {...stage(.32)}>and <em>keep the thread</em>.</motion.span>
          </h1>
          <motion.div className="platform-actions" {...stage(.5)}>
            {!STATIC_PRESENTATION && (
              <Link href="/overview"><PremiumButton variant="primary">Open workspace <span aria-hidden>→</span></PremiumButton></Link>
            )}
            <a href="https://github.com/kinqsradiollc/BrainRouter" target="_blank" rel="noopener noreferrer">
              <PremiumButton variant="ghost">View source</PremiumButton>
            </a>
          </motion.div>
          <motion.div className="platform-proof" aria-label="Where BrainRouter runs" {...stage(.62)}>
            <span>Desktop</span><span>CLI</span><span>Dashboard</span><span>MCP + API</span>
          </motion.div>
        </motion.div>
        <motion.aside className="platform-hero-cine-note" {...stage(.74)}>
          <p>Meetings, planner, notes, the board, the workbench, repositories, reviews, knowledge and org administration are one workspace — one set of permissions, one shared context, one thread through all of it.</p>
          <span><i /> six surfaces · one loop · one memory</span>
        </motion.aside>
      </motion.section>

      <motion.section className="platform-route-strip" aria-label="The BrainRouter loop" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .45 }} transition={{ duration: .55, ease: EASE }}>
        <span className="platform-route-label">The loop</span>
        <div>
          {LOOP_STAGES.map((item, index) => (
            <motion.span key={item.id} data-tone={item.tone}
              initial={reduceMotion ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: .6 }}
              transition={{ duration: .45, delay: reduceMotion ? 0 : index * .09, ease: EASE }}>
              <i />{item.label}{index < LOOP_STAGES.length - 1 && <b aria-hidden>→</b>}
            </motion.span>
          ))}
        </div>
        <small>Know feeds Plan. That is why it is a loop.</small>
      </motion.section>

      <ThreadNarrative renderLink={stageLink} />

      <motion.section className="platform-capabilities" id="platform" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .12 }} transition={{ duration: .6, ease: EASE }}>
        <header>
          <span className="platform-kicker">Underneath the loop</span>
          <h2>Engineering is the deepest surface, not the whole workspace.</h2>
          <p>The same task context runs through planning, implementation, connected systems, durable knowledge and review — so the loop above is one product rather than six tools that agree to share a login.</p>
        </header>
        <div className="platform-capability-list">
          {PRODUCT_CAPABILITIES.map((capability, index) => (
            <motion.article key={capability.index} data-tone={capability.tone} initial={reduceMotion ? false : { opacity: 0, x: 18 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: .55 }} transition={{ duration: .45, delay: reduceMotion ? 0 : index * .055, ease: EASE }}>
              <span className="platform-index">{capability.index}</span>
              <div><h3>{capability.title}</h3><p>{capability.copy}</p></div>
              <code>{capability.label}</code>
              <i className="platform-capability-signal" aria-hidden />
            </motion.article>
          ))}
        </div>
      </motion.section>

      <motion.section className="platform-system" id="workflows" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .15 }} transition={{ duration: .6, ease: EASE }}>
        <div className="platform-system-copy">
          <span className="platform-kicker">Shared core</span>
          <h2>Four ways in. One workspace.</h2>
          <p>Your models, permissions, connected tools, workflows and useful context stay the same wherever you open BrainRouter.</p>
        </div>
        <div className="platform-surface-grid">
          {PRODUCT_SURFACES.map((surface, index) => (
            <motion.article key={surface.title} data-tone={surface.tone} initial={reduceMotion ? false : { opacity: 0, scale: .985 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true, amount: .45 }} transition={{ duration: .4, delay: reduceMotion ? 0 : index * .06 }}><span>0{index + 1}</span><i aria-hidden /><h3>{surface.title}</h3><p>{surface.copy}</p></motion.article>
          ))}
        </div>
      </motion.section>

      <motion.section className="platform-principles" id="connectors" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .3 }} transition={{ duration: .55, ease: EASE }}>
        <div><span>Stay in control</span><p>Your workspace data and local actions remain under your control.</p></div>
        <div><span>Know before something changes</span><p>Permissions and approvals are visible when an action matters.</p></div>
        <div><span>Choose your models</span><p>Use supported model providers without rebuilding the way you work.</p></div>
      </motion.section>

      <motion.section className="platform-cta" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .4 }} transition={{ duration: .6, ease: EASE }}>
        <div className="platform-cta-orbit" aria-hidden><i /><i /><i /><i /><i /></div>
        <div><span className="platform-kicker">Start anywhere in the loop</span><h2>Pick the work back up where you left it.</h2></div>
        {!STATIC_PRESENTATION && <Link href="/overview"><PremiumButton variant="primary">Open BrainRouter <span aria-hidden>→</span></PremiumButton></Link>}
      </motion.section>
    </div>
  );
}
