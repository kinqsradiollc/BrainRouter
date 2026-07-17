export type ProductTone = "plan" | "build" | "connect" | "knowledge" | "review" | "automation";

export const PRODUCT_LOOP = [
  { label: "Plan", tone: "plan", detail: "Requirements and a visible route" },
  { label: "Build", tone: "build", detail: "Agent workbench and code execution" },
  { label: "Connect", tone: "connect", detail: "Repositories, services, MCP, and hooks" },
  { label: "Track", tone: "plan", detail: "Projects, meetings, teams, and task state" },
  { label: "Know", tone: "knowledge", detail: "Scoped memory, evidence, and recall" },
  { label: "Verify", tone: "review", detail: "Reviews, checks, pentests, and CVEs" },
] as const satisfies ReadonlyArray<{ label: string; tone: ProductTone; detail: string }>;

export const PRODUCT_CAPABILITIES = [
  {
    index: "01",
    title: "Build in an agent workbench",
    copy: "Move between conversation, code execution, project files, terminal, plans, requirements, and Track without losing the active task.",
    label: "Chat · Code · Track",
    tone: "build",
  },
  {
    index: "02",
    title: "Route models and specialist work",
    copy: "Choose governed models, coordinate focused agents and extensions, and keep permissions, approvals, and execution boundaries visible.",
    label: "Models · Agents · Policy",
    tone: "plan",
  },
  {
    index: "03",
    title: "Connect the systems around the task",
    copy: "Bring repositories, meetings, teams, issue trackers, documents, messages, MCP servers, hooks, and automations into one scoped workspace.",
    label: "Sources · Teams · Automation",
    tone: "connect",
  },
  {
    index: "04",
    title: "Keep knowledge useful and inspectable",
    copy: "Recall durable decisions with organization, project, workspace, owner, source, evidence, and contradiction boundaries still attached.",
    label: "Memory · Evidence · Recall",
    tone: "knowledge",
  },
  {
    index: "05",
    title: "Verify work before it ships",
    copy: "Review code and pull requests, run checks and pentests, and combine live CVE intelligence with exact repository evidence.",
    label: "Review · Security · CI",
    tone: "review",
  },
] as const satisfies ReadonlyArray<{ index: string; title: string; copy: string; label: string; tone: ProductTone }>;

export const PRODUCT_SURFACES = [
  { title: "Desktop", copy: "The primary Chat · Code · Track workbench for projects, agents, tools, terminal, automations, and reviews.", tone: "build" },
  { title: "CLI", copy: "A TTY-native coding agent with the same runtime, routing, policy, memory, orchestration, workflows, and goal loop.", tone: "automation" },
  { title: "Dashboard", copy: "Authenticated workbench, organizations, connections, knowledge, repositories, reviews, teams, and operations.", tone: "knowledge" },
  { title: "MCP + API", copy: "PostgreSQL-backed cognition and governed services for agents, editors, automations, and custom clients.", tone: "connect" },
] as const satisfies ReadonlyArray<{ title: string; copy: string; tone: ProductTone }>;

export const OVERVIEW_ACTIONS = [
  { href: "/chat", title: "Start an agent task", copy: "Ask, plan, build, or review with organization-scoped context.", meta: "Workbench", tone: "build" },
  { href: "/track", title: "Open Track", copy: "Move project and meeting work through visible states.", meta: "Projects", tone: "plan" },
  { href: "/meetings", title: "Capture a meeting", copy: "Record decisions, share safely, and turn follow-ups into work.", meta: "Meetings", tone: "automation" },
  { href: "/integrations", title: "Connect a source", copy: "Link repositories and knowledge accounts through sealed OAuth.", meta: "Connections", tone: "connect" },
  { href: "/knowledge", title: "Inspect knowledge", copy: "See what BrainRouter knows, why it appeared, and where it came from.", meta: "Knowledge", tone: "knowledge" },
  { href: "/reviews", title: "Review before shipping", copy: "Inspect pull requests, findings, checks, and review evidence.", meta: "Verification", tone: "review" },
] as const satisfies ReadonlyArray<{ href: string; title: string; copy: string; meta: string; tone: ProductTone }>;
