export interface PentestFindingMemoryInput {
  severity: string;
  summary: string;
  file?: string;
  line?: number;
  cvss?: number;
  cvssVector?: string;
  cwe?: string;
}

function safeLocation(value: string | undefined): string | undefined {
  const location = value?.trim();
  if (!location) return undefined;
  try {
    const parsed = new URL(location);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return location;
  }
}

export function pentestFindingMemoryMetadata(
  finding: PentestFindingMemoryInput,
  target: string,
): { content: string; filePaths: string[] } {
  const location = safeLocation(finding.file);
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
