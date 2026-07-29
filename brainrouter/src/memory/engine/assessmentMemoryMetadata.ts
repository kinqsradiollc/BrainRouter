export interface PentestFindingMemoryInput {
  severity: string;
  summary: string;
  file?: string;
  line?: number;
  cvss?: number;
  cvssVector?: string;
  cwe?: string;
}

export function pentestFindingMemoryMetadata(
  finding: PentestFindingMemoryInput,
  target: string,
): { content: string; filePaths: string[] } {
  const location = safeAssessmentLocation(finding.file);
  const content = [
    `SECURITY FINDING (${String(finding.severity).toUpperCase()}): ${finding.summary}`,
    finding.cwe ? `CWE: ${finding.cwe}` : "",
    typeof finding.cvss === "number"
      ? `CVSS: ${finding.cvss}${finding.cvssVector ? ` (${finding.cvssVector})` : ""}`
      : "",
    location ? `Location: ${location}${finding.line ? `:${finding.line}` : ""}` : "",
    `Target: ${target}`,
  ].filter(Boolean).join("\n");
  return { content, filePaths: location ? [location] : [] };
}
import { safeAssessmentLocation } from "../../reviews/assessmentLocation.js";
