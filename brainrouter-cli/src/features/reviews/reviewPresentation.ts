import type {
  AssuranceFindingView,
  ReviewAssuranceDetailView,
  ReviewSummaryView,
} from '@kinqs/brainrouter-core/review';

function location(finding: AssuranceFindingView): string {
  const line = finding.location.line ? `:${finding.location.line}` : '';
  const symbol = finding.location.symbol ? ` · ${finding.location.symbol}` : '';
  return `${finding.location.path}${line}${symbol}`;
}

export function renderReviewList(reviews: ReviewSummaryView[], canRun: boolean): string {
  if (reviews.length === 0) return 'No organization reviews were found.';
  const rows = reviews.map((review) => {
    const target = review.repo
      ? `${review.repo}${review.prNumber ? ` #${review.prNumber}` : ''}`
      : 'repository unavailable';
    const counts = review.findings === null
      ? ''
      : ` · ${review.findings} finding${review.findings === 1 ? '' : 's'}${review.blocking ? `, ${review.blocking} blocking` : ''}`;
    return `${review.id}  ${review.lens}  ${review.status}  ${target}${counts}`;
  });
  return [
    `Organization reviews${canRun ? ' · run permitted' : ' · read only'}`,
    ...rows,
    '',
    'Use /reviews <job-id> for durable run, coverage, evidence, and verifier detail.',
  ].join('\n');
}

function renderFinding(finding: AssuranceFindingView): string[] {
  const lines = [
    `  ${finding.severity.toUpperCase()} · ${finding.state} · ${finding.title}`,
    `    ${location(finding)} · confidence ${finding.confidence}`,
    `    Mechanism: ${finding.mechanism}`,
  ];
  for (const evidence of finding.evidence) {
    lines.push(`    Evidence [${evidence.kind}] ${evidence.id}: ${evidence.summary}`);
  }
  if (finding.verifier) {
    lines.push(
      `    Verifier ${finding.verifier.verifierId}: ${finding.verifier.state} · ${finding.verifier.rationale}`,
    );
  } else {
    lines.push('    Verifier: no disposition recorded');
  }
  for (const limitation of finding.coverageLimitations) {
    lines.push(`    Limitation [${limitation.state}] ${limitation.component}: ${limitation.summary}`);
  }
  return lines;
}

export function renderReviewAssuranceDetail(detail: ReviewAssuranceDetailView): string {
  const target = detail.review.repo
    ? `${detail.review.repo}${detail.review.prNumber ? ` #${detail.review.prNumber}` : ''}`
    : 'repository unavailable';
  const lines = [
    `Review ${detail.review.id}`,
    `${target} · ${detail.review.lens} · ${detail.review.status}${detail.canRun ? ' · run permitted' : ' · read only'}`,
  ];
  if (!detail.assurance) {
    return [...lines, '', 'Durable assurance: not recorded for this review.'].join('\n');
  }

  const { run, findings } = detail.assurance;
  lines.push(
    '',
    `Assurance ${run.id} · ${run.program} · ${run.status}`,
    `Revision ${run.revision.headSha}${run.revision.baseSha ? ` · base ${run.revision.baseSha}` : ''}`,
    `Policy ${run.policy.id} · ${run.policy.hash} · blocking ${run.policy.blockingEnabled ? 'enabled' : 'disabled'}`,
    `Source ${run.source.status} · ${run.source.indexedFileCount}/${run.source.textFileCount} text files indexed`,
    `Coverage ${run.coverage.status} · ${run.coverage.filesAnalyzed}/${run.coverage.filesEligible} eligible files · changed ${run.coverage.changedFilesAnalyzed}/${run.coverage.changedFilesTotal}`,
  );
  if (detail.assurance.publication) {
    lines.push(
      `Publication ${detail.assurance.publication.label} · ${detail.assurance.publication.conclusion}`,
      `Publication reason: ${detail.assurance.publication.reason}`,
    );
  }
  if (run.status === 'stale') lines.push(`Stale: ${run.staleReason}`);
  if (run.status === 'superseded') lines.push(`Superseded by ${run.supersededByRunId}`);
  for (const limitation of run.coverage.limitations) {
    lines.push(`Coverage limitation [${limitation.state}] ${limitation.component}: ${limitation.summary}`);
  }
  lines.push('', 'Stages');
  for (const stage of run.stages) {
    lines.push(`  ${stage.name} · ${stage.status} · attempt ${stage.attempt}${stage.errorCode ? ` · ${stage.errorCode}` : ''}`);
  }
  lines.push('', `Findings (${findings.length})`);
  if (findings.length === 0) lines.push('  No durable findings recorded.');
  for (const finding of findings) lines.push(...renderFinding(finding));
  return lines.join('\n');
}
