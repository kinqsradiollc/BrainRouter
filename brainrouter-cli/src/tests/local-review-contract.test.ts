import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string): string =>
  readFileSync(path.join(packageRoot, 'src', relative), 'utf8');

test('CLI review uses the shared orchestration with isolated read-only turns', () => {
  const handlers = read('cli/commands/workflow/handlers.ts');
  const local = read('cli/commands/workflow/localReview.ts');

  assert.match(handlers, /case '\/review':[\s\S]{0,2600}runCliLocalReview\(/);
  assert.doesNotMatch(handlers, /buildReviewPrompt/);
  assert.match(local, /runLocalReviewOrchestration\(/);
  assert.match(local, /READ_ONLY_REVIEW_TOOLS\s*=\s*\['read_file',\s*'list_dir',\s*'grep_search',\s*'glob_files'\]/);
  assert.doesNotMatch(local.match(/READ_ONLY_REVIEW_TOOLS[^;]+/)?.[0] ?? '', /lsp/);
  assert.match(local, /authorityToolCeiling:\s*\{[\s\S]{0,180}mcp:\s*\[\]/);
  assert.match(local, /enableRecall:\s*false/);
  assert.match(local, /reviewSourceSafety:\s*true/);
  assert.match(local, /roleOverlay:[\s\S]{0,180}UNTRUSTED_REVIEW_EVIDENCE_RULE/);
  assert.doesNotMatch(local, /systemPromptOverride/);
  assert.match(local, /disallowedTools:\s*\['fetch_url',\s*'web_search',\s*'mcp_call'\]/);
  assert.match(local, /reflection\.required[\s\S]{0,120}!orchestration\.review\.reflection\.reflected/);
  assert.match(handlers, /fix && result\.run\.status !== 'completed'/);
});
