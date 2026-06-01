/**
 * REFAC-DASHBOARD (0.4.6) — landing-page animation variants, demo workflow
 * data, and graph types, extracted verbatim from app/page.tsx. Pure
 * module-level constants/types with no component coupling — imported back into
 * page.tsx. No behavior change. (Conservative extraction: the dashboard has no
 * test net, so only component-independent data/types are moved here, gated by
 * `next build` + tsc.)
 */
export const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08
    }
  }
} as const;

export const itemVariants = {
  hidden: { opacity: 0, y: 25 },
  show: { 
    opacity: 1, 
    y: 0, 
    transition: { type: "spring", stiffness: 220, damping: 22 } 
  }
} as const;

export const pulseVariants = {
  animate: {
    scale: [1, 1.04, 1],
    opacity: [0.6, 1, 0.6],
    transition: {
      duration: 2.5,
      repeat: Infinity,
      ease: "easeInOut" as const
    }
  }
};

export const hoverScaleVariants = {
  hover: { scale: 1.015, y: -4, transition: { duration: 0.2, ease: "easeOut" as const } }
};

export const workflowExamples = [
  {
    id: "frontend",
    label: "Frontend Dev",
    request: "\"Generate a new marketing landing page for the enterprise tier.\"",
    l3: { title: "CORE PREFERENCES", detail: "Prefers TailwindCSS code" },
    l2: { title: "ACTIVE SKILL PRE-WARM (L2)", name: "UI-Styling", potential: 3.5, hints: "Always inject Tailwind responsive grids..." },
    l1: { title: "RECENT CONTEXT (L1)", detail: "Discussed 'Obsidian Dark Theme'" },
    execution: "The AI outputs a landing page using Tailwind code in a dark theme. It gets it right on the very first try because BrainRouter provided the exact memory layers and pre-warmed skill rules it needed.",
    feedback: { metric: "What memory was useful?", action: "↑ UI-Styling Spike (+1.0)" },
    distill: { metric: "What new facts happened?", action: "UI-Styling potential refreshed" }
  },
  {
    id: "analyst",
    label: "Data Analyst",
    request: "\"Write a script to visualize the Q3 Revenue data.\"",
    l3: { title: "CORE PREFERENCES", detail: "Prefers Python & Pandas" },
    l2: { title: "ACTIVE SKILL PRE-WARM (L2)", name: "Data-Visualization", potential: 3.2, hints: "Use seaborn, hex #cc9166 for accent curves..." },
    l1: { title: "RECENT CONTEXT (L1)", detail: "Always use Hex #cc9166 in charts" },
    execution: "The AI outputs a perfect Python script using Pandas, and automatically styles the charts using seaborn and the golden hex code, avoiding generic blue defaults.",
    feedback: { metric: "What memory was useful?", action: "↑ Data-Visualization Spike (+1.0)" },
    distill: { metric: "What new facts happened?", action: "Data-Visualization potential refreshed" }
  },
  {
    id: "sales",
    label: "Customer Success",
    request: "\"Draft a reply to this frustrated user about the bug.\"",
    l3: { title: "CORE PREFERENCES", detail: "Empathetic, professional tone" },
    l2: { title: "ACTIVE SKILL PRE-WARM (L2)", name: "Customer-Relations", potential: 3.8, hints: "Include subscription tier & de-escalation checklist..." },
    l1: { title: "RECENT CONTEXT (L1)", detail: "User has been subscribed for 3 years" },
    execution: "The AI writes a highly empathetic email acknowledging their 3-year loyalty on the Enterprise plan, immediately de-escalating the situation without needing manual prompt rewrites.",
    feedback: { metric: "What memory was useful?", action: "↑ Customer-Relations Spike (+1.0)" },
    distill: { metric: "What new facts happened?", action: "Customer-Relations potential refreshed" }
  }
];

export interface VisualNode {
  id: string;
  label: string;
  type: "dialogue" | "cr" | "cf" | "ci" | "skill";
  x: number;
  y: number;
  opacity: number;
  size: number;
}

export interface VisualLink {
  source: string;
  target: string;
  type: string;
  weight?: number;
}
