"use client";

import { useState } from "react";
import type { VisualNode, VisualLink } from "./landingData";

export type LearningStep = "idle" | "ingested" | "extracted" | "consolidated" | "decayed";

/**
 * Encapsulates the interactive "Consolidation & Learning" demo on the landing
 * page: the staged cognitive-graph nodes/links, the engine log stream, and the
 * step transitions (ingest → extract → consolidate → decay). Extracted from
 * `app/page.tsx` so the page component stays a thin layout shell.
 */
export function useConsolidationDemo() {
  const [learningStep, setLearningStep] = useState<LearningStep>("idle");
  const [consolidationLogs, setConsolidationLogs] = useState<string[]>([
    "Consolidation Engine standing by. Ingest a dialogue turn to begin."
  ]);
  const [visNodes, setVisNodes] = useState<VisualNode[]>([
    { id: "ci-1", label: "Tailwind UI Developer Profile", type: "ci", x: 325, y: 275, opacity: 1, size: 22 }
  ]);
  const [visLinks, setVisLinks] = useState<VisualLink[]>([]);

  const getCoords = (nodeId: string) => {
    const node = visNodes.find(n => n.id === nodeId);
    return node ? { x: node.x, y: node.y } : { x: 0, y: 0 };
  };

  const handleIngest = () => {
    setLearningStep("ingested");
    setVisNodes([
      { id: "ci-1", label: "Tailwind UI Developer Profile", type: "ci", x: 325, y: 275, opacity: 1, size: 22 },
      { id: "d-1", label: "Dialogue: Obsidian Next.js", type: "dialogue", x: 325, y: 35, opacity: 1, size: 16 }
    ]);
    setVisLinks([]);
    setConsolidationLogs(prev => [
      ...prev,
      "[SENSORY STREAM] Ingested dialogue turn #14 into Dialogue Buffer.",
      "[BUFFER] Raw input: 'I want to deploy the Next.js dashboard with a dark obsidian scheme.' Awaiting LLM processing."
    ]);
  };

  const handleExtract = () => {
    setLearningStep("extracted");
    setVisNodes([
      { id: "ci-1", label: "Tailwind UI Developer Profile", type: "ci", x: 325, y: 275, opacity: 1, size: 22 },
      { id: "cr-1", label: "Next.js Router", type: "cr", x: 100, y: 130, opacity: 1, size: 11 },
      { id: "cr-2", label: "Obsidian Dark", type: "cr", x: 325, y: 75, opacity: 1, size: 11 },
      { id: "cr-3", label: "Tailwind CSS", type: "cr", x: 550, y: 130, opacity: 1, size: 11 }
    ]);
    setVisLinks([
      { source: "cr-1", target: "cr-2", type: "semantic", weight: 0.5 },
      { source: "cr-2", target: "cr-3", type: "semantic", weight: 0.5 }
    ]);
    setConsolidationLogs(prev => [
      ...prev,
      "[COGNITIVE EXTRACTOR] Triggered background LLM extraction task.",
      "[EXTRACTOR] Extracted 3 new cognitive records (CR) from dialogue turn.",
      "[DEDUP] Audited conflicts. No active contradictions found."
    ]);
  };

  const handleConsolidate = () => {
    setLearningStep("consolidated");
    setVisNodes([
      { id: "ci-1", label: "Tailwind UI Developer Profile (Obsidian Added)", type: "ci", x: 325, y: 275, opacity: 1, size: 22 },
      { id: "cr-1", label: "Next.js Router", type: "cr", x: 100, y: 130, opacity: 1, size: 11 },
      { id: "cr-2", label: "Obsidian Dark", type: "cr", x: 325, y: 75, opacity: 1, size: 11 },
      { id: "cr-3", label: "Tailwind CSS", type: "cr", x: 550, y: 130, opacity: 1, size: 11 },
      { id: "cf-1", label: "Obsidian Dev Scene", type: "cf", x: 325, y: 195, opacity: 1, size: 18 }
    ]);
    setVisLinks([
      { source: "cr-1", target: "cf-1", type: "scene-member", weight: 0.8 },
      { source: "cr-2", target: "cf-1", type: "scene-member", weight: 0.8 },
      { source: "cr-3", target: "cf-1", type: "scene-member", weight: 0.8 },
      { source: "cf-1", target: "ci-1", type: "distillation", weight: 0.94 }
    ]);
    setConsolidationLogs(prev => [
      ...prev,
      "[RELATIONSHIP ENGINE] Synaptic spreading activation triggered in memory graph.",
      "[GRAPH BUILDER] Clustered cognitive records into Focus Scene 'Obsidian Dev' (CF-1).",
      "[SYNAPTIC PLASTICITY] Strengthened cognitive connections (Hebbian LTP) between co-cited memories to weight 0.80.",
      "[IDENTITY DISTILLER] Synthesized Core Identity. Distilled preference 'Obsidian theme' (weight 0.94) into persistent profile."
    ]);
  };

  const handleSimulateDecay = () => {
    setLearningStep("decayed");
    setVisNodes([
      { id: "ci-1", label: "Tailwind UI Developer Profile (Obsidian Added)", type: "ci", x: 325, y: 275, opacity: 1, size: 22 },
      { id: "cr-1", label: "Next.js Router", type: "cr", x: 100, y: 130, opacity: 0.4, size: 11 },
      { id: "cr-2", label: "Obsidian Dark", type: "cr", x: 325, y: 75, opacity: 1.0, size: 11 },
      { id: "cr-3", label: "Tailwind CSS", type: "cr", x: 550, y: 130, opacity: 0.4, size: 11 },
      { id: "cf-1", label: "Obsidian Dev Scene", type: "cf", x: 325, y: 195, opacity: 1, size: 18 }
    ]);
    setVisLinks([
      { source: "cr-1", target: "cf-1", type: "scene-member", weight: 0.32 },
      { source: "cr-2", target: "cf-1", type: "scene-member", weight: 0.8 },
      { source: "cr-3", target: "cf-1", type: "scene-member", weight: 0.32 },
      { source: "cf-1", target: "ci-1", type: "distillation", weight: 0.94 }
    ]);
    setConsolidationLogs(prev => [
      ...prev,
      "[DECAY ENGINE] Synaptic connection weights decayed (LTD) by 0.9x factor.",
      "[FORGETTING CURVE] Connections for Next.js Router (CR-1) and Tailwind CSS (CR-3) decayed to weight 0.32.",
      "[STABILITY] Preserved connections with high consolidation strength; pruned weak weights < 0.10."
    ]);
  };

  return {
    learningStep,
    consolidationLogs,
    visNodes,
    visLinks,
    getCoords,
    handleIngest,
    handleExtract,
    handleConsolidate,
    handleSimulateDecay,
  };
}
