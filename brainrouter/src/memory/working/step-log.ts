import fs from "node:fs";
import path from "node:path";

export interface WorkingStep {
  nodeId: string;
  title: string;
  summary: string;
  kind: string;
  createdAt: string;
  refPath?: string;
  tokenEstimate: number;
}

export interface StepLogCompressionResult {
  steps: WorkingStep[];
  compressed: boolean;
}

export function appendWorkingStep(workDir: string, step: WorkingStep): void {
  fs.mkdirSync(workDir, { recursive: true });
  fs.appendFileSync(path.join(workDir, "steps.jsonl"), `${JSON.stringify(step)}\n`, "utf8");
}

export function readWorkingSteps(workDir: string): WorkingStep[] {
  const stepsPath = path.join(workDir, "steps.jsonl");
  if (!fs.existsSync(stepsPath)) return [];

  return fs.readFileSync(stepsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkingStep);
}

export function compressStepLog(workDir: string, keepLast = 5): StepLogCompressionResult {
  const steps = readWorkingSteps(workDir);
  if (steps.length <= keepLast) {
    return { steps, compressed: false };
  }

  const archived = steps.slice(0, -keepLast);
  const retained = steps.slice(-keepLast);
  const archiveStep: WorkingStep = {
    nodeId: `summary-${Date.now()}`,
    title: `Compressed ${archived.length} earlier steps`,
    summary: archived.map((step) => `${step.title}: ${step.summary}`).join(" | "),
    kind: "compressed_summary",
    createdAt: new Date().toISOString(),
    tokenEstimate: archived.reduce((total, step) => total + step.tokenEstimate, 0),
  };
  const nextSteps = [archiveStep, ...retained];

  fs.writeFileSync(
    path.join(workDir, "steps.jsonl"),
    `${nextSteps.map((step) => JSON.stringify(step)).join("\n")}\n`,
    "utf8"
  );

  return { steps: nextSteps, compressed: true };
}
