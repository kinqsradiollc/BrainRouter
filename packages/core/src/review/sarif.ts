import type { ReviewFinding, ReviewRun } from './reviewModel.js';

export interface SarifLog {
  version: '2.1.0';
  $schema: string;
  runs: Array<Record<string, unknown>>;
}

/** Convert persisted review findings to portable SARIF 2.1.0. */
export function reviewRunToSarif(run: Pick<ReviewRun, 'repoRoot' | 'headRef' | 'findings'>): SarifLog {
  const rules = new Map<string, Record<string, unknown>>();
  const results = run.findings.map((finding) => {
    const ruleId = finding.cwe?.trim() || 'BRAINROUTER-REVIEW';
    if (!rules.has(ruleId)) rules.set(ruleId, {
      id: ruleId,
      name: ruleId,
      shortDescription: { text: finding.summary },
      help: { text: finding.remediation || 'Review and remediate this finding.' },
      properties: finding.cwe ? { tags: [finding.cwe.toLowerCase(), 'security'] } : { tags: ['security'] },
    });
    return {
      ruleId,
      level: finding.severity === 'critical' || finding.severity === 'high' ? 'error' : finding.severity === 'medium' ? 'warning' : 'note',
      message: { text: finding.details || finding.summary },
      locations: [{ physicalLocation: { artifactLocation: { uri: finding.file }, region: finding.line ? { startLine: finding.line, endLine: finding.endLine ?? finding.line } : undefined } }],
      properties: { confidence: finding.confidence, cvss: finding.cvss, cvssVector: finding.cvssVector, cwe: finding.cwe, cve: finding.cve, poc: finding.poc },
    };
  });
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'BrainRouter pentest', informationUri: 'https://brainrouter.ai', rules: [...rules.values()] } },
      artifacts: [{ location: { uri: run.repoRoot } }],
      versionControlProvenance: run.headRef ? [{ revisionId: run.headRef }] : [],
      results,
    }],
  };
}
