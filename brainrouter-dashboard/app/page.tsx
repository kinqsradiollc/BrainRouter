"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { PremiumButton } from "../components/PremiumButton";
import { STATIC_PRESENTATION } from "../lib/presentation";

type WorkflowTone = "plan" | "build" | "connect" | "knowledge" | "review" | "automation";

const CAPABILITIES = [
  {
    index: "01",
    title: "Build with an agent workbench",
    copy: "Move between read-only chat, code execution, project tracking, plans, requirements, and visual workflows without losing the active task.",
    label: "Chat · Code · Track",
    tone: "build" as WorkflowTone,
  },
  {
    index: "02",
    title: "Use the right help for each task",
    copy: "Choose the model you prefer, bring in focused helpers when work grows, and stay in control of what they can change.",
    label: "Models · Helpers · Permissions",
    tone: "plan" as WorkflowTone,
  },
  {
    index: "03",
    title: "Connect the systems you use",
    copy: "Bring repositories, MCP servers, knowledge sources, hooks, and automation triggers into one governed workspace.",
    label: "Connectors · MCP · Hooks",
    tone: "connect" as WorkflowTone,
  },
  {
    index: "04",
    title: "Keep context that improves",
    copy: "Recall durable knowledge, inspect evidence and contradictions, manage persona, and understand why context appeared in a turn.",
    label: "Memory · Evidence · Recall",
    tone: "knowledge" as WorkflowTone,
  },
  {
    index: "05",
    title: "Review before work ships",
    copy: "Inspect diffs, requirements, plans, checks, and PR feedback from the same task surface that produced the change.",
    label: "Review · Verify · CI",
    tone: "review" as WorkflowTone,
  },
];

const SURFACES = [
  ["Desktop", "The full agent workbench for projects, sessions, tools, workflows, and reviews.", "build"],
  ["CLI", "A fast terminal head with the same routing, policy, memory, and orchestration core.", "automation"],
  ["Dashboard", "Workspace administration, connected sources, knowledge inspection, and team visibility.", "knowledge"],
  ["MCP", "Composable tools that let other agents use BrainRouter capabilities through a governed protocol.", "connect"],
] as const;

const WORKFLOW = [
  ["Plan", "plan"],
  ["Build", "build"],
  ["Connect", "connect"],
  ["Remember", "knowledge"],
  ["Verify", "review"],
] as const;

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

  return (
    <div className="platform-landing">
      <motion.section className="platform-hero" initial={reduceMotion ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .7, ease: [0.16, 1, 0.3, 1] }}>
        <div className="platform-hero-atmosphere" aria-hidden>
          <i data-tone="plan" /><i data-tone="build" /><i data-tone="knowledge" /><i data-tone="review" />
        </div>
        <div className="platform-hero-copy">
          <span className="platform-kicker"><i /> Agent operations system</span>
          <h1>Move from <em>intent</em> to verified work in one workspace.</h1>
          <p>BrainRouter brings conversation, coding, planning, connected knowledge, automation, and review into one place. Start with a task and keep the right project context with you through the verified result.</p>
          <div className="platform-actions">
            {!STATIC_PRESENTATION && (
              <Link href="/overview"><PremiumButton variant="primary">Open workspace <span aria-hidden>→</span></PremiumButton></Link>
            )}
            <a href="https://github.com/kinqsradiollc/BrainRouter" target="_blank" rel="noopener noreferrer">
              <PremiumButton variant="ghost">View source</PremiumButton>
            </a>
          </div>
          <div className="platform-proof" aria-label="BrainRouter product surfaces">
            <span>Desktop</span><span>CLI</span><span>Dashboard</span><span>MCP</span>
          </div>
        </div>

        <div className="platform-preview" aria-label="BrainRouter desktop workspace preview">
          <div className="platform-preview-glow" aria-hidden />
          <div className="platform-preview-bar"><span /><strong>BrainRouter</strong><small><i /> workspace live</small></div>
          <div className="platform-preview-body">
            <aside>
              <b>Modes</b>
              <span>Chat</span><span className="active" data-tone="build"><i />Code</span><span>Track</span>
              <b>Workspace</b>
              <span className="active" data-tone="plan"><i />BrainRouter</span><span>Recent tasks</span>
            </aside>
            <div className="platform-preview-main">
              <div className="platform-preview-context"><span>Objective</span><strong>Ship the connected agent workspace</strong><small><i /> In progress</small></div>
              <div className="platform-preview-message"><i>BR</i><p>I’ll inspect the active project, update the plan, and keep changes behind the existing verification gates.</p></div>
              <div className="platform-preview-steps">
                <span className="done"><i />Read workspace instructions<small>done</small></span>
                <span className="done"><i />Map affected surfaces<small>done</small></span>
                <span className="running"><i />Implement and verify<small>running</small></span>
              </div>
              <div className="platform-preview-activity" aria-label="Active workspace signals">
                <span data-tone="plan"><i />Plan ready</span><span data-tone="knowledge"><i />8 memories</span><span data-tone="review"><i />2 checks</span>
              </div>
              <div className="platform-preview-composer"><span>Ask BrainRouter to build, explain, or review…</span><b>↑</b></div>
            </div>
          </div>
        </div>
      </motion.section>

      <motion.section className="platform-route-strip" aria-label="BrainRouter workflow" initial={revealInitial} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .45 }} transition={{ duration: .55, ease: [0.16, 1, 0.3, 1] }}>
        <span className="platform-route-label">One continuous task</span>
        <div>
          {WORKFLOW.map(([label, tone], index) => <span key={label} data-tone={tone}><i />{label}{index < WORKFLOW.length - 1 && <b aria-hidden>→</b>}</span>)}
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
          {CAPABILITIES.map((capability, index) => (
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
          {SURFACES.map(([title, copy, tone], index) => (
            <motion.article key={title} data-tone={tone} initial={reduceMotion ? false : { opacity: 0, scale: .985 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true, amount: .45 }} transition={{ duration: .4, delay: reduceMotion ? 0 : index * .06 }}><span>0{index + 1}</span><i aria-hidden /><h3>{title}</h3><p>{copy}</p></motion.article>
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
