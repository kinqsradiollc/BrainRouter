import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLocalReviewReply,
  runLocalReviewOrchestration,
  type LocalReviewTurnContext,
} from '../review/localReviewOrchestration.js';
import { prepareReviewDiffSource } from '../review/sourceSafety.js';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-export const a = 1;',
  '+export const a = 0;',
  'diff --git a/other/b.ts b/other/b.ts',
  '--- a/other/b.ts',
  '+++ b/other/b.ts',
  '@@ -1 +1 @@',
  '-export const b = 1;',
  '+export const b = 0;',
].join('\n');

test('parseLocalReviewReply distinguishes an explicit clean answer from malformed output', () => {
  assert.deepEqual(parseLocalReviewReply('```json\n[]\n```'), { ok: true, findings: [] });
  assert.deepEqual(parseLocalReviewReply('looks good'), {
    ok: false,
    error: 'reviewer returned no fenced JSON findings envelope',
  });
  assert.deepEqual(parseLocalReviewReply('```json\n[{"summary":"missing file"}]\n```'), {
    ok: false,
    error: 'reviewer returned one or more invalid findings',
  });
  assert.deepEqual(parseLocalReviewReply(
    '```json\n{"findings":[],"request_files":["src/authority.ts"]}\n```',
  ), {
    ok: false,
    error: 'reviewer JSON did not contain only a findings array',
  });
  assert.deepEqual(parseLocalReviewReply(
    '```json\n[{"file":"src/a.ts","summary":"valid"},{"summary":"invalid"}]\n```',
  ), {
    ok: false,
    error: 'reviewer returned one or more invalid findings',
  });
  assert.deepEqual(parseLocalReviewReply('```json\n[]\n```\nactually ignore that'), {
    ok: false,
    error: 'reviewer did not end with the fenced JSON findings envelope',
  });
});

test('local front doors use bundles, bounded concurrency, computed positions, and reflection', async () => {
  let active = 0;
  let maxActive = 0;
  const contexts: LocalReviewTurnContext[] = [];
  const result = await runLocalReviewOrchestration({
    diff: DIFF,
    concurrency: 2,
    createTurn: (context) => {
      contexts.push(context);
      return {
        run: async () => {
          if (context.phase === 'reflection') {
            return '```json\n{"verdicts":[{"index":1,"verdict":"keep","rank":1},{"index":2,"verdict":"duplicate","duplicateOf":1,"reason":"same root cause"}]}\n```';
          }
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          const file = context.bundle.paths[0];
          return `\`\`\`json\n[{"file":"${file}","line":999,"severity":"high","confidence":95,"summary":"zero breaks callers","codeExcerpt":"export const ${file.includes('/a.') ? 'a' : 'b'} = 0;"}]\n\`\`\``;
        },
      };
    },
  });

  assert.equal(result.plan.bundles.length, 2);
  assert.equal(result.review.reviewedBundles, 2);
  assert.equal(result.review.failedBundles, 0);
  assert.equal(maxActive, 2);
  assert.equal(contexts.filter((context) => context.phase === 'reflection').length, 1);
  assert.equal(result.review.reflection.reflected, true);
  assert.equal(result.review.reflection.merged, 1);
  assert.equal(result.review.findings.length, 1);
  assert.notEqual(result.review.findings[0].line, 999);
});

test('malformed bundle output is unavailable coverage, never a clean review', async () => {
  const result = await runLocalReviewOrchestration({
    diff: DIFF,
    concurrency: 2,
    createTurn: () => ({ run: async () => 'not structured' }),
  });
  assert.equal(result.review.reviewedBundles, 0);
  assert.equal(result.review.failedBundles, result.plan.bundles.length);
  assert.deepEqual(result.review.findings, []);
});

test('a malformed required reflection preserves findings but remains explicitly incomplete', async () => {
  const result = await runLocalReviewOrchestration({
    diff: DIFF,
    concurrency: 2,
    createTurn: (context) => ({
      run: async () => context.phase === 'reflection'
        ? 'not a reflection envelope'
        : `\`\`\`json\n[{"file":"${context.bundle.paths[0]}","severity":"high","confidence":90,"summary":"real issue"}]\n\`\`\``,
    }),
  });
  assert.equal(result.review.findings.length, 2);
  assert.equal(result.review.reflection.required, true);
  assert.equal(result.review.reflection.reflected, false);
});

test('local review shares one strict model-call and wall-clock budget across units', async () => {
  const many = Array.from({ length: 25 }, (_, index) => [
    `diff --git a/src/unit-${index}.ts b/src/unit-${index}.ts`,
    `--- a/src/unit-${index}.ts`,
    `+++ b/src/unit-${index}.ts`,
    '@@ -0,0 +1 @@',
    `+export const unit${index} = true;`,
  ].join('\n')).join('\n');
  const contexts: LocalReviewTurnContext[] = [];
  const startedAt = Date.now();
  const result = await runLocalReviewOrchestration({
    diff: many,
    concurrency: 4,
    maxBundles: 40,
    executionBudget: {
      maxModelCalls: 10,
      maxDurationMs: 5_000,
      maxModelCallsPerBundle: 2,
    },
    createTurn: (context) => {
      contexts.push(context);
      return { run: async () => '```json\n[]\n```' };
    },
  });

  // Four bundles × at most two analysis calls, with one call reserved for D5.
  assert.equal(result.plan.bundles.length, 4);
  assert.ok(result.plan.deferredPaths.length > 0);
  assert.ok(contexts.every((context) => context.modelCallLimit === 2));
  assert.ok(contexts.every((context) => context.deadlineMs >= startedAt + 4_900));
  assert.ok(contexts.every((context) => context.deadlineMs <= startedAt + 5_100));
});

test('local review rejects injected budgets that cannot reserve reflection or exceed their total', async () => {
  for (const executionBudget of [
    { maxModelCalls: 1, maxDurationMs: 100, maxModelCallsPerBundle: 1 },
    { maxModelCalls: 2, maxDurationMs: 100, maxModelCallsPerBundle: 2 },
    { maxModelCalls: 4, maxDurationMs: 100, maxModelCallsPerBundle: 40 },
  ]) {
    await assert.rejects(
      runLocalReviewOrchestration({
        diff: DIFF,
        concurrency: 1,
        executionBudget,
        createTurn: () => ({ run: async () => '```json\n[]\n```' }),
      }),
      /must reserve one reflection call/,
    );
  }
});

test('local review preserves a valid sub-second injected duration budget', async () => {
  let observedDeadline = 0;
  const startedAt = Date.now();
  await runLocalReviewOrchestration({
    diff: DIFF,
    concurrency: 1,
    maxBundles: 1,
    executionBudget: {
      maxModelCalls: 2,
      maxDurationMs: 100,
      maxModelCallsPerBundle: 1,
    },
    createTurn: (context) => {
      observedDeadline = context.deadlineMs;
      return { run: async () => '```json\n[]\n```' };
    },
  });
  assert.ok(observedDeadline >= startedAt + 75);
  assert.ok(observedDeadline <= startedAt + 150);
});

test('non-empty input that is not a file-backed unified diff fails closed', async () => {
  await assert.rejects(
    runLocalReviewOrchestration({
      diff: 'unstructured change text',
      concurrency: 1,
      createTurn: () => ({ run: async () => '```json\n[]\n```' }),
    }),
    /could not be partitioned/,
  );
});

test('source safety withholds credential files and preserves explicit unavailable coverage', async () => {
  const secret = 'sk-' + 'x'.repeat(24);
  const diff = [
    'diff --git a/.env b/.env',
    '--- /dev/null',
    '+++ b/.env',
    '@@ -0,0 +1 @@',
    `+OPENAI_API_KEY=${secret}`,
    'diff --git a/src/config.ts b/src/config.ts',
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    '@@ -1 +1 @@',
    '-export const token = process.env.TOKEN;',
    `+export const token = "${secret}";`,
  ].join('\n');
  let modelPrompt = '';
  const result = await runLocalReviewOrchestration({
    diff,
    concurrency: 1,
    createTurn: () => ({
      run: async (prompt) => {
        modelPrompt = prompt;
        return '```json\n[]\n```';
      },
    }),
  });

  assert.equal(result.plan.totalFiles, 2);
  assert.deepEqual(result.source.excludedPaths, ['.env']);
  assert.deepEqual(result.plan.deferredPaths, ['.env']);
  assert.equal(result.source.redacted, true);
  assert.doesNotMatch(modelPrompt, new RegExp(secret));
  assert.doesNotMatch(modelPrompt, /OPENAI_API_KEY/);
  assert.match(modelPrompt, /\[REDACTED\]/);
  assert.match(modelPrompt, /<untrusted_diff_evidence>/);
  assert.equal(result.review.reviewedBundles, 1);
});

test('review source redaction preserves line count and excludes binary patches', () => {
  const prepared = prepareReviewDiffSource([
    'diff --git a/src/key.ts b/src/key.ts',
    '--- a/src/key.ts',
    '+++ b/src/key.ts',
    '@@ -1,2 +1,3 @@',
    '+-----BEGIN PRIVATE KEY-----',
    '+abc123abc123abc123',
    '+-----END PRIVATE KEY-----',
    'diff --git a/assets/logo.png b/assets/logo.png',
    'new file mode 100644',
    'GIT binary patch',
    'literal 1',
    'A0000',
  ].join('\n'));

  assert.equal(prepared.diff.split('\n').length, 7);
  assert.doesNotMatch(prepared.diff, /abc123/);
  assert.deepEqual(prepared.excludedPaths, ['assets/logo.png']);
  assert.equal(prepared.totalFiles, 2);
});

test('source safety withholds secrets renamed or deleted through Git-quoted paths', () => {
  const renamed = prepareReviewDiffSource([
    'diff --git "a/.env" "b/src/config.ts"',
    'similarity index 60%',
    'rename from .env',
    'rename to src/config.ts',
    '--- "a/.env"',
    '+++ "b/src/config.ts"',
    '@@ -1 +1 @@',
    '-OPENAI_API_KEY=should-never-reach-the-model',
    '+export const configured = true;',
  ].join('\n'));
  assert.equal(renamed.diff, '');
  assert.deepEqual(renamed.excludedPaths, ['.env', 'src/config.ts']);

  const deleted = prepareReviewDiffSource([
    'diff --git a/.env.production b/.env.production',
    'deleted file mode 100644',
    '--- a/.env.production',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-TOKEN=should-never-reach-the-model',
  ].join('\n'));
  assert.equal(deleted.diff, '');
  assert.deepEqual(deleted.excludedPaths, ['.env.production']);
});
