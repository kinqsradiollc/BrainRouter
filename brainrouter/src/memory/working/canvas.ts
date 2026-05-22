import fs from "node:fs";
import path from "node:path";
import type { WorkingStep } from "./step-log.js";

function escapeMermaidLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "'")
    .replaceAll("\n", " ")
    .slice(0, 96);
}

export function buildWorkingCanvas(steps: WorkingStep[]): string {
  return buildAnnotatedCanvas(steps);
}

export function buildAnnotatedCanvas(steps: WorkingStep[], activeNodeId?: string): string {
  const lines = ["flowchart TD"];
  if (steps.length === 0) {
    lines.push("  empty[\"No working memory steps yet\"]");
    return lines.join("\n");
  }

  for (const step of steps) {
    const label = escapeMermaidLabel(`${step.title}\\n${step.summary}`);
    const prefix = step.nodeId === activeNodeId ? "🌟 " : "";
    lines.push(`  ${step.nodeId}["${prefix}${label}"]`);
  }

  for (let index = 1; index < steps.length; index += 1) {
    lines.push(`  ${steps[index - 1].nodeId} --> ${steps[index].nodeId}`);
  }

  if (activeNodeId && steps.some((step) => step.nodeId === activeNodeId)) {
    lines.push(`  style ${activeNodeId} fill:#2b6cb0,stroke:#3182ce,stroke-width:2px,color:#fff`);
  }

  return lines.join("\n");
}

export function writeWorkingCanvas(workDir: string, steps: WorkingStep[]): string {
  const canvas = buildWorkingCanvas(steps);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "canvas.mmd"), canvas, "utf8");
  return canvas;
}

export function readWorkingCanvas(workDir: string): string {
  const canvasPath = path.join(workDir, "canvas.mmd");
  if (!fs.existsSync(canvasPath)) return buildWorkingCanvas([]);
  return fs.readFileSync(canvasPath, "utf8");
}
