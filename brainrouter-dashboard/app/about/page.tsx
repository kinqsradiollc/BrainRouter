"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { STATIC_PRESENTATION } from "../../lib/presentation";
import styles from "./about.module.css";

const GITHUB_URL = "https://github.com/kinqsradiollc/BrainRouter";

const LOOP = [
  ["01", "Plan", "Turn intent into requirements, tasks, and a visible route through the work.", "plan"],
  ["02", "Build", "Use chat, code execution, tools, and bounded specialist workers in the active project.", "build"],
  ["03", "Connect", "Bring repositories, issue trackers, documents, messages, MCP servers, and hooks into scope.", "connect"],
  ["04", "Track", "Keep project state, repository changes, workflows, and automation attached to the task.", "plan"],
  ["05", "Know", "Recall useful decisions with sources, evidence, ownership, and explicit workspace scope.", "knowledge"],
  ["06", "Verify", "Review diffs and pull requests, run checks, and surface findings before work ships.", "review"],
] as const;

const SURFACES = [
  { name: "Desktop", role: "Primary workbench", detail: "Chat, Code, Track, files, plans, tools, terminal, automations, and reviews in one project shell.", tone: "build" },
  { name: "CLI", role: "Terminal workbench", detail: "The same agent runtime, routing, policies, memory, and orchestration in a fast TTY-native interface.", tone: "automation" },
  { name: "Dashboard", role: "Connected workspace", detail: "Team scope, account connections, providers, knowledge, repositories, review jobs, and system health.", tone: "knowledge" },
  { name: "MCP + API", role: "Composable runtime", detail: "Governed tools and authenticated HTTP contracts for other agents, editors, services, and custom clients.", tone: "connect" },
] as const;

const TRUST = [
  ["Actions stay explicit", "Local execution, file changes, and sensitive tools remain behind the runtime's permission and approval policy."],
  ["Credentials stay behind the service", "Account connections use server-sealed OAuth tokens. Provider secrets are write-only and are never returned to clients."],
  ["Knowledge carries scope", "Organization, project, workspace, owner, and source boundaries travel with retrieval instead of relying on a global client cache."],
  ["Review stays evidence-led", "Findings point back to code, diffs, tests, and attributable vulnerability intelligence rather than model confidence alone."],
] as const;

export default function AboutPage() {
  const reduceMotion = useReducedMotion();
  const reveal = reduceMotion ? false : { opacity: 0, y: 22 };
  const transition = { duration: .58, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <div className={styles.about}>
      <motion.section className={styles.hero} initial={reveal} animate={{ opacity: 1, y: 0 }} transition={transition}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}><i /> Why BrainRouter exists</span>
          <h1>Agent work should remain one continuous, inspectable system.</h1>
          <p>BrainRouter is an open agent operations workspace for the path from intent to verified result. It keeps the task, project, connected systems, permissions, useful context, and review evidence together across desktop, terminal, browser, and MCP clients.</p>
          <div className={styles.actions}>
            {!STATIC_PRESENTATION && <Link href="/overview" className={styles.primaryAction}>Open workspace <span aria-hidden>→</span></Link>}
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={styles.secondaryAction}>View source</a>
          </div>
        </div>
        <div className={styles.systemMap} aria-label="BrainRouter product architecture">
          <div className={styles.mapHeader}><span>Shared task state</span><small><i /> active</small></div>
          <div className={styles.surfaceNodes}>
            {SURFACES.map((surface) => <span key={surface.name} data-tone={surface.tone}><i />{surface.name}</span>)}
          </div>
          <div className={styles.mapRoute} aria-hidden><i /><i /><i /></div>
          <div className={styles.coreNode}>
            <span>BrainRouter core</span>
            <strong>Agent runtime · router · policy · memory · Track · review</strong>
          </div>
          <div className={styles.coreSignals}>
            <span data-tone="build">Build</span><span data-tone="plan">Plan</span><span data-tone="knowledge">Knowledge</span><span data-tone="automation">Automation</span><span data-tone="review">Review</span>
          </div>
        </div>
      </motion.section>

      <motion.section className={styles.loopSection} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .12 }} transition={transition}>
        <header>
          <span className={styles.eyebrow}>The operating loop</span>
          <h2>From a request to work you can trust.</h2>
          <p>Each capability is useful alone. The product becomes more valuable when state and evidence survive the hand-off between them.</p>
        </header>
        <div className={styles.loopList}>
          {LOOP.map(([index, title, detail, tone], itemIndex) => (
            <motion.article key={title} data-tone={tone} initial={reduceMotion ? false : { opacity: 0, x: 18 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: .55 }} transition={{ ...transition, delay: reduceMotion ? 0 : itemIndex * .045 }}>
              <span>{index}</span><i aria-hidden /><div><h3>{title}</h3><p>{detail}</p></div>
            </motion.article>
          ))}
        </div>
      </motion.section>

      <motion.section className={styles.surfacesSection} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .16 }} transition={transition}>
        <div className={styles.sectionHeading}>
          <span className={styles.eyebrow}>One core, four surfaces</span>
          <h2>Choose the interface. Keep the system.</h2>
          <p>Models, account connections, project scope, policies, durable knowledge, and review results do not become separate products when you change interface.</p>
        </div>
        <div className={styles.surfaceGrid}>
          {SURFACES.map((surface, index) => (
            <motion.article key={surface.name} data-tone={surface.tone} initial={reduceMotion ? false : { opacity: 0, scale: .985 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true, amount: .45 }} transition={{ ...transition, delay: reduceMotion ? 0 : index * .055 }}>
              <span>0{index + 1}</span><i aria-hidden /><small>{surface.role}</small><h3>{surface.name}</h3><p>{surface.detail}</p>
            </motion.article>
          ))}
        </div>
      </motion.section>

      <motion.section className={styles.trustSection} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .15 }} transition={transition}>
        <div className={styles.trustCopy}>
          <span className={styles.eyebrow}>Trust boundaries</span>
          <h2>Control is part of the architecture.</h2>
          <p>BrainRouter can coordinate powerful local and hosted capabilities without pretending every action, credential, or piece of knowledge belongs in the same trust zone.</p>
          <a href={`${GITHUB_URL}/blob/HEAD/SECURITY.md`} target="_blank" rel="noopener noreferrer">Read the security policy <span aria-hidden>→</span></a>
        </div>
        <div className={styles.trustList}>
          {TRUST.map(([title, detail], index) => <article key={title}><span>0{index + 1}</span><div><h3>{title}</h3><p>{detail}</p></div></article>)}
        </div>
      </motion.section>

      <motion.section className={styles.openSection} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .28 }} transition={transition}>
        <div>
          <span className={styles.eyebrow}>Open and adaptable</span>
          <h2>Run the workspace on your terms.</h2>
          <p>The repository is MIT-licensed. Self-host the brain and dashboard, use the desktop or CLI locally, choose supported model providers, and extend the runtime through MCP, hooks, connectors, skills, and agents.</p>
        </div>
        <div className={styles.installBlock}>
          <span>Install the terminal and brain</span>
          <code><b>$</b> npm install -g @kinqs/brainrouter-cli @kinqs/brainrouter-mcp-server</code>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">Clone and inspect the system <span aria-hidden>→</span></a>
        </div>
      </motion.section>

      <motion.section className={styles.maintainer} initial={reveal} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .4 }} transition={transition}>
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
