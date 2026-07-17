"use client";

import Link from "next/link";
import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion";
import { PremiumButton } from "../components/PremiumButton";
import { ProductOrbit } from "../components/ProductOrbit";
import { PRODUCT_CAPABILITIES, PRODUCT_LOOP, PRODUCT_SURFACES } from "../lib/homeProductStory";
import { STATIC_PRESENTATION } from "../lib/presentation";

const KNOWLEDGE_STEPS = [
  {
    index: "01",
    title: "Carries decisions across sessions",
    copy: "Project choices, preferences, and lessons stay available, so the next conversation does not begin from zero.",
  },
  {
    index: "02",
    title: "Keeps the current task focused",
    copy: "Short-term notes stay close to the active task while durable knowledge remains ready for later work.",
  },
  {
    index: "03",
    title: "Finds what is useful now",
    copy: "BrainRouter combines meaning, keywords, file paths, and related ideas to choose a small, relevant set of context.",
  },
  {
    index: "04",
    title: "Shows where knowledge came from",
    copy: "Evidence stays attached, disagreements are flagged, and you can inspect why something was recalled.",
  },
  {
    index: "05",
    title: "Improves as work continues",
    copy: "Useful knowledge becomes easier to find. Outdated or unused information can fade instead of crowding every prompt.",
  },
] as const;

export default function HomePage() {
  const reduceMotion = useReducedMotion();
  const revealInitial = reduceMotion ? false : { opacity: 0, y: 24 };
  // Cinematic hero staging: kicker → headline lines → copy → actions → proof,
  // then the operations graph "powers on". Collapses to no-ops under reduced motion.
  const stage = (delay: number) => reduceMotion ? {} : {
    initial: { opacity: 0, y: 26, filter: "blur(6px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: .65, delay, ease: [0.16, 1, 0.3, 1] as const },
  };

  // Scroll choreography: a page progress beam, and a film-style exit — the
  // foreground title card rises away while the scene behind it slowly zooms
  // in (backgrounds move less than foregrounds). Inert under reduced motion.
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 170, damping: 30, mass: 0.3 });
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroCopyY = useTransform(heroProgress, [0, 1], [0, -80]);
  const heroVisualY = useTransform(heroProgress, [0, 1], [0, 46]);
  const heroVisualScale = useTransform(heroProgress, [0, 1], [1, 1.08]);

  return (
    <div className="platform-landing">
      <motion.div className="platform-scroll-progress" style={reduceMotion ? undefined : { scaleX: progress }} aria-hidden />
      {/* Immersive hero — the operations graph IS the viewport; copy floats on
          the scene like a title card. On exit the scene zooms subtly while the
          foreground rises away (film-style pull). */}
      <motion.section ref={heroRef} className="platform-hero-cine" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .6 }}>
        <motion.div className="platform-hero-cine-scene" aria-hidden style={reduceMotion ? undefined : { y: heroVisualY, scale: heroVisualScale }}>
          <ProductOrbit immersive />
        </motion.div>
        <div className="platform-hero-cine-grade" aria-hidden />
        <motion.div className="platform-hero-cine-fg" style={reduceMotion ? undefined : { y: heroCopyY }}>
          <motion.span className="platform-kicker" {...stage(0)}><i /> Open agent operations workspace</motion.span>
          <h1>
            <motion.span className="platform-hero-line" {...stage(.08)}>Move every agent</motion.span>
            <motion.span className="platform-hero-line" {...stage(.2)}>task from <em>intent</em></motion.span>
            <motion.span className="platform-hero-line" {...stage(.32)}>to verified work.</motion.span>
          </h1>
          <motion.div className="platform-actions" {...stage(.5)}>
            {!STATIC_PRESENTATION && (
              <Link href="/overview"><PremiumButton variant="primary">Open workspace <span aria-hidden>→</span></PremiumButton></Link>
            )}
            <a href="https://github.com/kinqsradiollc/BrainRouter" target="_blank" rel="noopener noreferrer">
              <PremiumButton variant="ghost">View source</PremiumButton>
            </a>
          </motion.div>
          <motion.div className="platform-proof" aria-label="BrainRouter product surfaces" {...stage(.62)}>
            <span>Desktop</span><span>CLI</span><span>Dashboard</span><span>MCP + API</span>
          </motion.div>
        </motion.div>
        <motion.aside className="platform-hero-cine-note" {...stage(.74)}>
          <p>BrainRouter keeps the workbench, models, projects, teams, connected systems, permissions, durable knowledge, automation, and review evidence on one shared task path.</p>
          <span><i /> task state synchronized · models · tools · sources · memory · review</span>
        </motion.aside>
      </motion.section>

      <motion.section className="platform-route-strip" aria-label="BrainRouter workflow" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .45 }} transition={{ duration: .55, ease: [0.16, 1, 0.3, 1] }}>
        <span className="platform-route-label">One continuous task</span>
        <div>
          {PRODUCT_LOOP.map((step, index) => (
            <motion.span key={step.label} data-tone={step.tone}
              initial={reduceMotion ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: .6 }}
              transition={{ duration: .45, delay: reduceMotion ? 0 : index * .09, ease: [0.16, 1, 0.3, 1] }}>
              <i />{step.label}{index < PRODUCT_LOOP.length - 1 && <b aria-hidden>→</b>}
            </motion.span>
          ))}
        </div>
        <small>Shared project · permissions · context</small>
      </motion.section>

      <motion.section className="platform-capabilities" id="platform" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .12 }} transition={{ duration: .6, ease: [0.16, 1, 0.3, 1] }}>
        <header>
          <span className="platform-kicker">One task, every capability</span>
          <h2>The workspace changes with the work.</h2>
          <p>Use the same task context across planning, implementation, connected data, durable knowledge, and review.</p>
        </header>
        <div className="platform-capability-list">
          {PRODUCT_CAPABILITIES.map((capability, index) => (
            <motion.article key={capability.index} data-tone={capability.tone} initial={reduceMotion ? false : { opacity: 0, x: 18 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: .55 }} transition={{ duration: .45, delay: reduceMotion ? 0 : index * .055, ease: [0.16, 1, 0.3, 1] }}>
              <span className="platform-index">{capability.index}</span>
              <div><h3>{capability.title}</h3><p>{capability.copy}</p></div>
              <code>{capability.label}</code>
              <i className="platform-capability-signal" aria-hidden />
            </motion.article>
          ))}
        </div>
      </motion.section>

      <motion.section className="platform-knowledge" id="knowledge" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .12 }} transition={{ duration: .6, ease: [0.16, 1, 0.3, 1] }}>
        <div className="platform-knowledge-heading">
          <span className="platform-kicker">Knowledge that stays understandable</span>
          <h2>BrainRouter remembers without becoming a black box.</h2>
          <p>It keeps the parts of work worth carrying forward, brings back only what helps, and lets you inspect or correct the result.</p>
          {!STATIC_PRESENTATION && <Link href="/knowledge" className="platform-text-link">Explore knowledge <span aria-hidden>→</span></Link>}
        </div>
        <div className="platform-knowledge-list">
          {KNOWLEDGE_STEPS.map((step, index) => (
            <motion.article key={step.index} initial={reduceMotion ? false : { opacity: 0, x: 18 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: .6 }} transition={{ duration: .4, delay: reduceMotion ? 0 : index * .045 }}>
              <span>{step.index}</span>
              <div><h3>{step.title}</h3><p>{step.copy}</p></div>
            </motion.article>
          ))}
        </div>
      </motion.section>

      <motion.section className="platform-system" id="workflows" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .15 }} transition={{ duration: .6, ease: [0.16, 1, 0.3, 1] }}>
        <div className="platform-system-copy">
          <span className="platform-kicker">Shared core</span>
          <h2>Four ways to work. One workspace.</h2>
          <p>Your models, permissions, connected tools, workflows, and useful context stay consistent wherever you use BrainRouter.</p>
        </div>
        <div className="platform-surface-grid">
          {PRODUCT_SURFACES.map((surface, index) => (
            <motion.article key={surface.title} data-tone={surface.tone} initial={reduceMotion ? false : { opacity: 0, scale: .985 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true, amount: .45 }} transition={{ duration: .4, delay: reduceMotion ? 0 : index * .06 }}><span>0{index + 1}</span><i aria-hidden /><h3>{surface.title}</h3><p>{surface.copy}</p></motion.article>
          ))}
        </div>
      </motion.section>

      <motion.section className="platform-principles" id="connectors" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .3 }} transition={{ duration: .55, ease: [0.16, 1, 0.3, 1] }}>
        <div><span>Stay in control</span><p>Your workspace data and local actions remain under your control.</p></div>
        <div><span>Know before something changes</span><p>Permissions and approvals are visible when an action matters.</p></div>
        <div><span>Choose your models</span><p>Use supported model providers without rebuilding the way you work.</p></div>
      </motion.section>

      <motion.section className="platform-cta" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .4 }} transition={{ duration: .6, ease: [0.16, 1, 0.3, 1] }}>
        <div className="platform-cta-orbit" aria-hidden><i /><i /><i /><i /><i /></div>
        <div><span className="platform-kicker">Start from the task</span><h2>Move work forward without losing context.</h2></div>
        {!STATIC_PRESENTATION && <Link href="/overview"><PremiumButton variant="primary">Open BrainRouter <span aria-hidden>→</span></PremiumButton></Link>}
      </motion.section>
    </div>
  );
}
