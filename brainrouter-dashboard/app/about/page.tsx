/**
 * `/about` — what BrainRouter is, told as one continuous day rather than a
 * feature list.
 *
 * The page is built around a single device: a thread. It is drawn as you
 * scroll, it passes through six stations (Plan · Meet · Write · Build · Verify
 * · Know), and between stations it carries something concrete from one surface
 * to the next. The motion is the argument — memory is not the product here, it
 * is the reason the other five survive contact with each other.
 *
 * INVARIANTS
 * - Every animation collapses to a no-op under `prefers-reduced-motion`.
 * - Copy and routes come from `aboutStory.ts`, which is the place the "no
 *   capability we do not have" rule is enforced.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion";
import { STATIC_PRESENTATION } from "../../lib/presentation";
import { STORY_STATIONS, STORY_SURFACES, STORY_TRUST, THREAD_PROOF, type StoryRoute } from "./aboutStory";
import styles from "./about.module.css";

const GITHUB_URL = "https://github.com/kinqsradiollc/BrainRouter";
const EASE = [0.16, 1, 0.3, 1] as const;

/** The six thread nodes in the hero diagram, in draw order. */
const THREAD_NODES = [
  { x: 72, y: 56 },
  { x: 168, y: 148 },
  { x: 92, y: 246 },
  { x: 188, y: 340 },
  { x: 104, y: 438 },
  { x: 196, y: 524 },
] as const;

const THREAD_PATH =
  "M72 56 C 72 110, 168 96, 168 148 S 92 192, 92 246 S 188 288, 188 340 S 104 384, 104 438 S 196 470, 196 524";

/**
 * Route chips point into the product. In presentation-only mode the
 * authenticated routes are not served, so they render as plain labels rather
 * than links that would go nowhere.
 */
function RouteChip({ route }: { route: StoryRoute }) {
  if (STATIC_PRESENTATION) return <span className={styles.routeChip}>{route.label}</span>;
  return <Link href={route.href} className={styles.routeChip}>{route.label}<span aria-hidden>→</span></Link>;
}

/** The hero thread: one line, drawn once, with a pulse that keeps travelling it. */
function ThreadDiagram({ reduceMotion }: { reduceMotion: boolean | null }) {
  const still = Boolean(reduceMotion);
  return (
    <svg className={styles.threadSvg} viewBox="0 0 268 576" fill="none" aria-hidden focusable="false">
      <path d={THREAD_PATH} stroke="var(--border-strong)" strokeWidth="1.25" strokeLinecap="round" />
      <motion.path
        d={THREAD_PATH}
        stroke="var(--text-secondary)"
        strokeWidth="1.25"
        strokeLinecap="round"
        initial={still ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 2.4, ease: "easeInOut", delay: 0.25 }}
      />
      {THREAD_NODES.map((node, index) => (
        <motion.g
          key={`${node.x}-${node.y}`}
          initial={still ? false : { opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.35 + index * 0.34, ease: EASE }}
          style={{ transformOrigin: `${node.x}px ${node.y}px` }}
        >
          <circle cx={node.x} cy={node.y} r="11" fill="var(--accent-wash)" />
          <circle cx={node.x} cy={node.y} r="4.5" fill="var(--surface-base)" stroke="var(--text-secondary)" strokeWidth="1.25" />
        </motion.g>
      ))}
      {!still && (
        <motion.circle
          r="3"
          fill="var(--text)"
          initial={{ cx: THREAD_NODES[0].x, cy: THREAD_NODES[0].y, opacity: 0 }}
          animate={{
            cx: THREAD_NODES.map((node) => node.x),
            cy: THREAD_NODES.map((node) => node.y),
            opacity: [0, 1, 1, 1, 1, 0],
          }}
          transition={{ duration: 7.2, delay: 2.4, ease: "easeInOut", repeat: Infinity, repeatDelay: 0.6 }}
        />
      )}
    </svg>
  );
}

/** The connector between two stations: what the previous one hands over. */
function Handoff({ label, reduceMotion }: { label: string; reduceMotion: boolean | null }) {
  const still = Boolean(reduceMotion);
  return (
    <div className={styles.handoff}>
      <motion.i
        className={styles.handoffLine}
        aria-hidden
        initial={still ? false : { scaleY: 0 }}
        whileInView={{ scaleY: 1 }}
        viewport={{ once: true, amount: 0.6 }}
        transition={{ duration: 0.5, ease: EASE }}
      />
      <motion.span
        className={styles.handoffToken}
        initial={still ? false : { opacity: 0, y: -22 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.9 }}
        transition={{ duration: 0.55, delay: still ? 0 : 0.18, ease: EASE }}
      >
        <b aria-hidden />carries {label}
      </motion.span>
    </div>
  );
}

export default function AboutPage() {
  const reduceMotion = useReducedMotion();
  const still = Boolean(reduceMotion);
  const reveal = still ? false : { opacity: 0, y: 22 };
  const transition = { duration: 0.58, ease: EASE };
  /** Title-card staging, matching the language the rest of the marketing uses. */
  const stage = (delay: number) => still ? {} : {
    initial: { opacity: 0, y: 24, filter: "blur(6px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: 0.6, delay, ease: EASE },
  };

  const { scrollYProgress } = useScroll();
  const pageProgress = useSpring(scrollYProgress, { stiffness: 170, damping: 30, mass: 0.3 });

  /** The thread's own progress: it fills only while the loop is on screen. */
  const spineRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress: spineScroll } = useScroll({ target: spineRef, offset: ["start 60%", "end 80%"] });
  const spineFill = useSpring(spineScroll, { stiffness: 140, damping: 28, mass: 0.4 });
  const headTop = useTransform(spineFill, [0, 1], ["0%", "100%"]);

  /** Which station the reader is in — drives the rail, reduced motion or not. */
  const [activeStation, setActiveStation] = useState<string>(STORY_STATIONS[0].id);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActiveStation(visible.target.id);
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.5, 1] },
    );
    for (const station of STORY_STATIONS) {
      const node = document.getElementById(station.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.about}>
      <motion.div className="platform-scroll-progress" style={still ? undefined : { scaleX: pageProgress }} aria-hidden />

      {/* Opening — the claim, and the thread that will carry it. */}
      <section className={styles.opening} aria-labelledby="about-title">
        <div className={styles.openingCopy}>
          <motion.span className={styles.eyebrow} {...stage(0)}><i />One workspace your agents actually work in</motion.span>
          <h1 id="about-title">
            <motion.span {...stage(0.08)}>Plan the day, run the meeting,</motion.span>
            <motion.span {...stage(0.18)}>write the doc, ship the change —</motion.span>
            <motion.span {...stage(0.28)}>and keep the thread.</motion.span>
          </h1>
          <motion.p {...stage(0.4)}>
            BrainRouter is one workspace a whole team works in. Six things happen in it every week, and the
            useful part is not any one of them — it is that the sixth still knows what happened in the first.
          </motion.p>
          <motion.div className={styles.actions} {...stage(0.5)}>
            {!STATIC_PRESENTATION && <Link href="/overview" className={styles.primaryAction}>Open the workspace <span aria-hidden>→</span></Link>}
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={styles.secondaryAction}>Read the source</a>
          </motion.div>
          <motion.ul className={styles.loopChips} aria-label="The loop" {...stage(0.6)}>
            {STORY_STATIONS.map((station, index) => (
              <li key={station.id} data-tone={station.tone}>
                <a href={`#${station.id}`}>{station.step}</a>
                {index < STORY_STATIONS.length - 1 && <b aria-hidden>·</b>}
              </li>
            ))}
          </motion.ul>
        </div>
        <motion.div
          className={styles.openingThread}
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          <ThreadDiagram reduceMotion={reduceMotion} />
        </motion.div>
      </section>

      {/* The loop — six stations on one thread, with the hand-offs named. */}
      <section className={styles.spine} aria-labelledby="loop-title">
        <motion.header className={styles.spineIntro} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.4 }} transition={transition}>
          <span className={styles.eyebrow}><i />A week, in one line</span>
          <h2 id="loop-title">Work changes hands six times. It should not start over each time.</h2>
          <p>
            Each of these is a surface you can open on its own. What makes them a workspace is the line between
            them: the thing one hands to the next, still carrying where it came from.
          </p>
        </motion.header>

        <div className={styles.spineBody} ref={spineRef}>
          <nav className={styles.rail} aria-label="Jump to a step">
            <span className={styles.railTrack} aria-hidden>
              <motion.i className={styles.railFill} style={still ? { scaleY: 1 } : { scaleY: spineFill }} />
              {!still && <motion.b className={styles.railHead} style={{ top: headTop }} />}
            </span>
            <ol>
              {STORY_STATIONS.map((station) => (
                <li key={station.id}>
                  <a href={`#${station.id}`} data-active={activeStation === station.id} aria-current={activeStation === station.id ? "true" : undefined}>
                    {station.step}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <ol className={styles.scenes}>
            {STORY_STATIONS.map((station, index) => (
              <li key={station.id}>
                <motion.article
                  id={station.id}
                  className={styles.scene}
                  data-tone={station.tone}
                  initial={still ? false : { opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.35 }}
                  transition={transition}
                >
                  <span className={styles.sceneStep}>0{index + 1}<b aria-hidden />{station.step}</span>
                  <h3>{station.title}</h3>
                  <p>{station.copy}</p>
                  <div className={styles.sceneRoutes}>
                    {station.routes.map((route) => <RouteChip key={route.href} route={route} />)}
                  </div>
                </motion.article>
                {index < STORY_STATIONS.length - 1
                  ? <Handoff label={station.carries} reduceMotion={reduceMotion} />
                  : <motion.p
                      className={styles.loopClose}
                      initial={still ? false : { opacity: 0 }}
                      whileInView={{ opacity: 1 }}
                      viewport={{ once: true, amount: 0.8 }}
                      transition={transition}
                    >
                      <span aria-hidden>↺</span> and it carries {station.carries}
                    </motion.p>}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* The hinge — memory, stated as the reason the other five hold together. */}
      <section className={styles.hinge} aria-labelledby="thread-title">
        <motion.div className={styles.hingeCopy} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }} transition={transition}>
          <span className={styles.eyebrow}><i />Keep the thread</span>
          <h2 id="thread-title">Memory is not the product. It is why the other five survive each other.</h2>
          <p>
            A workspace that remembers everything and can explain nothing is a liability. So the record you get
            back can be taken apart: it names its source, its scope, its ranking, and the moment it changed.
          </p>
        </motion.div>
        <ul className={styles.proofList}>
          {THREAD_PROOF.map((proof, index) => (
            <motion.li
              key={proof.question}
              initial={still ? false : { opacity: 0, x: 26 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ ...transition, delay: still ? 0 : index * 0.06 }}
            >
              <i aria-hidden />
              <div>
                <h3>{proof.question}</h3>
                <p>{proof.answer}</p>
              </div>
              <RouteChip route={proof.route} />
            </motion.li>
          ))}
        </ul>
      </section>

      {/* Where the same workspace can be opened from. */}
      <section className={styles.surfaces} aria-labelledby="surfaces-title">
        <motion.div className={styles.sectionHeading} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.4 }} transition={transition}>
          <span className={styles.eyebrow}><i />Four doors, one room</span>
          <h2 id="surfaces-title">Change the window. Keep the workspace.</h2>
          <p>Models, connected accounts, project scope, permissions, knowledge, and review results do not turn into four separate products when you switch surface.</p>
        </motion.div>
        <div className={styles.surfaceGrid}>
          {STORY_SURFACES.map((surface, index) => (
            <motion.article
              key={surface.name}
              data-tone={surface.tone}
              initial={still ? false : { opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ ...transition, delay: still ? 0 : index * 0.06 }}
            >
              <span>0{index + 1}</span>
              <i aria-hidden />
              <small>{surface.role}</small>
              <h3>{surface.name}</h3>
              <p>{surface.detail}</p>
            </motion.article>
          ))}
        </div>
      </section>

      {/* Trust boundaries — stated as what the system will not do. */}
      <section className={styles.trust} aria-labelledby="trust-title">
        <motion.div className={styles.trustCopy} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.35 }} transition={transition}>
          <span className={styles.eyebrow}><i />Boundaries</span>
          <h2 id="trust-title">A shared workspace is only useful if sharing is a decision.</h2>
          <p>Meetings, notes, knowledge, and tools each carry a scope, and powerful actions stay behind an approval instead of being assumed.</p>
          <a href={`${GITHUB_URL}/blob/HEAD/SECURITY.md`} target="_blank" rel="noopener noreferrer">Read the security policy <span aria-hidden>→</span></a>
        </motion.div>
        <div className={styles.trustList}>
          {STORY_TRUST.map((item, index) => (
            <motion.article
              key={item.title}
              initial={still ? false : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ ...transition, delay: still ? 0 : index * 0.05 }}
            >
              <span>0{index + 1}</span>
              <div><h3>{item.title}</h3><p>{item.detail}</p></div>
            </motion.article>
          ))}
        </div>
      </section>

      {/* Open source, and who to talk to. */}
      <motion.section className={styles.open} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }} transition={transition}>
        <div>
          <span className={styles.eyebrow}><i />Open and adaptable</span>
          <h2>Run the workspace on your terms.</h2>
          <p>The repository is MIT-licensed. Host it yourself, use the desktop app or the terminal locally, choose your model providers, and extend the runtime through MCP, hooks, connectors, skills, and agents.</p>
        </div>
        <div className={styles.installBlock}>
          <span>Install the terminal workspace and the server</span>
          <code><b>$</b> npm install -g @kinqs/brainrouter-cli @kinqs/brainrouter-mcp-server</code>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">Clone and inspect the system <span aria-hidden>→</span></a>
        </div>
      </motion.section>

      <motion.section className={styles.maintainer} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.4 }} transition={transition}>
        <div className={styles.avatar} aria-hidden>AD</div>
        <div><span>Created and maintained by</span><strong>Anh Dang</strong><small>BrainRouter creator and core maintainer</small></div>
        <div className={styles.contactLinks}>
          <a href="mailto:anhdang@brainrouter.dev">Email</a>
          <a href="https://www.linkedin.com/in/tran-duc-anh-dang-392b7a231/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </motion.section>
    </div>
  );
}
