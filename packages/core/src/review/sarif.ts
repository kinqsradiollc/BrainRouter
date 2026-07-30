import type { ReviewFinding, ReviewRun } from './reviewModel.js';

export interface SarifLog {
  version: '2.1.0';
  $schema: string;
  runs: Array<Record<string, unknown>>;
}

/** STRIDE legs: (S)poofing (T)ampering (R)epudiation (I)nfo-disclosure
 * (D)enial-of-service (E)levation-of-privilege. Tagging SARIF rules with a
 * STRIDE leg lets code-scanning group findings by threat-model category. */
const CWE_TO_STRIDE: Record<string, string[]> = {
  'cwe-79': ['T', 'I'], 'cwe-89': ['T', 'I'], 'cwe-78': ['E', 'T'], 'cwe-94': ['E', 'T'], 'cwe-95': ['E', 'T'],
  'cwe-22': ['I'], 'cwe-23': ['I'], 'cwe-98': ['E', 'I'], 'cwe-611': ['I'], 'cwe-918': ['I'], 'cwe-200': ['I'],
  'cwe-352': ['T', 'S'], 'cwe-287': ['S'], 'cwe-306': ['S', 'E'], 'cwe-862': ['E'], 'cwe-863': ['E'], 'cwe-639': ['E', 'I'],
  'cwe-269': ['E'], 'cwe-250': ['E'], 'cwe-502': ['E', 'T'], 'cwe-434': ['E'], 'cwe-798': ['S', 'I'], 'cwe-522': ['S', 'I'],
  'cwe-601': ['T'], 'cwe-400': ['D'], 'cwe-770': ['D'], 'cwe-284': ['E'], 'cwe-732': ['E', 'I'], 'cwe-16': ['T', 'I'],
  'cwe-1188': ['E'], 'cwe-497': ['I'], 'cwe-209': ['I'], 'cwe-311': ['I'], 'cwe-327': ['I'], 'cwe-916': ['S'],
};

/** STRIDE legs for a CWE id (e.g. "CWE-79"); defaults to Tampering+Info when unmapped. */
export function strideLegsForCwe(cwe?: string): string[] {
  const key = cwe?.trim().toLowerCase();
  return (key && CWE_TO_STRIDE[key]) || ['T', 'I'];
}

/** Convert persisted review findings to portable SARIF 2.1.0. */
export function reviewRunToSarif(run: Pick<ReviewRun, 'repoRoot' | 'headRef' | 'findings'>): SarifLog {
  const rules = new Map<string, Record<string, unknown>>();
  const results = run.findings.map((finding) => {
    const ruleId = finding.cwe?.trim() || 'BRAINROUTER-REVIEW';
    if (!rules.has(ruleId)) {
      const cweNum = /^cwe-(\d+)$/i.exec(ruleId.trim());
      const strideTags = finding.cwe ? strideLegsForCwe(finding.cwe).map((leg) => `stride:${leg}`) : [];
      rules.set(ruleId, {
        id: ruleId,
        name: ruleId,
        shortDescription: { text: finding.summary },
        help: { text: finding.remediation || 'Review and remediate this finding.' },
        ...(cweNum ? { helpUri: `https://cwe.mitre.org/data/definitions/${cweNum[1]}.html` } : {}),
        properties: { tags: [...(finding.cwe ? [finding.cwe.toLowerCase()] : []), ...strideTags, 'security'] },
      });
    }
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
