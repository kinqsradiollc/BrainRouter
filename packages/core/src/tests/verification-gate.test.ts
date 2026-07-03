import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import {
  classifyForVerification,
  commandWritesFiles,
  isDocsOrConfigPath,
  decideVerification,
  shouldNudgeVerification,
  buildVerificationNudge,
  buildDocsOnlyVerificationNote,
} from '../agent/turn/verificationGate.js';
import { withTempWorkspaceAsync } from './_helpers.js';

// --- pure classifiers -------------------------------------------------------

test('classifyForVerification: edits mutate; build/test commands verify', () => {
  assert.equal(classifyForVerification('edit_file'), 'mutated');
  assert.equal(classifyForVerification('write_file'), 'mutated');
  assert.equal(classifyForVerification('apply_patch'), 'mutated');
  assert.equal(classifyForVerification('run_command', 'npm test'), 'verified');
  assert.equal(classifyForVerification('run_command', 'npm run build'), 'verified');
  assert.equal(classifyForVerification('run_command', 'vitest run src/'), 'verified');
  assert.equal(classifyForVerification('run_command', 'cargo check'), 'verified');
  assert.equal(classifyForVerification('run_command', 'tsc --noEmit'), 'verified');
});

test('classifyForVerification: only FILE-WRITING shell counts; reads are neutral (scoping fix)', () => {
  // Read-only / non-writing shell commands no longer trip the guardrail.
  assert.equal(classifyForVerification('run_command', 'git status'), 'none');
  assert.equal(classifyForVerification('run_command', 'git add -A'), 'none');
  assert.equal(classifyForVerification('run_command', 'ls -la'), 'none');
  assert.equal(classifyForVerification('run_command', 'cat package.json'), 'none');
  assert.equal(classifyForVerification('run_command', 'grep -r foo src'), 'none');
  assert.equal(classifyForVerification('run_command', 'echo hi'), 'none');
  assert.equal(classifyForVerification('run_command', 'node x.js 2>&1'), 'none');
  assert.equal(classifyForVerification('run_command', 'cmd > /dev/null'), 'none');
  // File-writing shell commands DO count.
  assert.equal(classifyForVerification('run_command', 'echo x > src/a.ts'), 'mutated');
  assert.equal(classifyForVerification('run_command', 'sed -i s/a/b/ src/a.ts'), 'mutated');
  assert.equal(classifyForVerification('run_command', 'mv a.ts b.ts'), 'mutated');
  assert.equal(classifyForVerification('run_command', 'rm src/old.ts'), 'mutated');
  assert.equal(classifyForVerification('read_file'), 'none');
  assert.equal(classifyForVerification('grep_search'), 'none');
});

test('commandWritesFiles: redirects + write commands, not reads', () => {
  assert.equal(commandWritesFiles('echo x >> out.log'), true);
  assert.equal(commandWritesFiles('tee a.txt'), true);
  assert.equal(commandWritesFiles('git status'), false);
  assert.equal(commandWritesFiles('node app.js 2>&1'), false);
  assert.equal(commandWritesFiles('curl x > /dev/null'), false);
});

test('commandWritesFiles: a redirect/write-verb INSIDE a quoted arg is not a write', () => {
  // Read-only investigation greps: the `>` / write-verb lives in the pattern,
  // not the shell — these must NOT trip the verification guardrail.
  assert.equal(commandWritesFiles("grep 'a > b' *.ts"), false);
  assert.equal(commandWritesFiles('grep -rn "x >> y" src'), false);
  assert.equal(commandWritesFiles(`grep "rm -rf" .`), false);
  assert.equal(commandWritesFiles("rg 'return a > b' packages"), false);
  // A real redirect OUTSIDE quotes still counts.
  assert.equal(commandWritesFiles(`grep 'a > b' *.ts > out.txt`), true);
});

test('isDocsOrConfigPath: docs + config, not code (.txt is ambiguous → not docs)', () => {
  assert.equal(isDocsOrConfigPath('README.md'), true);
  assert.equal(isDocsOrConfigPath('docs/guide.mdx'), true);
  assert.equal(isDocsOrConfigPath('tsconfig.json'), true);
  assert.equal(isDocsOrConfigPath('config/app.yaml'), true);
  assert.equal(isDocsOrConfigPath('.gitignore'), true);
  assert.equal(isDocsOrConfigPath('.npmrc'), true);
  assert.equal(isDocsOrConfigPath('src/index.ts'), false);
  assert.equal(isDocsOrConfigPath('main.py'), false);
  assert.equal(isDocsOrConfigPath('notes.txt'), false); // ambiguous → treated as code
});

test('decideVerification: code write → verify; docs-only → report; reads → none', () => {
  // Wrote code, no check → demand verification.
  assert.equal(decideVerification({ filesWritten: ['src/a.ts'], shellWroteUnknown: false, verified: false, alreadyNudged: false }), 'verify');
  // Wrote only docs/config → ask the agent to state no verification was needed.
  assert.equal(decideVerification({ filesWritten: ['README.md', 'package.json'], shellWroteUnknown: false, verified: false, alreadyNudged: false }), 'report-docs-only');
  // Wrote nothing this turn (e.g. user just switched, or read-only turn) → never fires.
  assert.equal(decideVerification({ filesWritten: [], shellWroteUnknown: false, verified: false, alreadyNudged: false }), 'none');
  // A check already ran → satisfied.
  assert.equal(decideVerification({ filesWritten: ['src/a.ts'], shellWroteUnknown: false, verified: true, alreadyNudged: false }), 'none');
  // Already nudged once this turn → don't repeat.
  assert.equal(decideVerification({ filesWritten: ['src/a.ts'], shellWroteUnknown: false, verified: false, alreadyNudged: true }), 'none');
  // Docs files but an opaque shell write also happened → can't rule docs-only → verify.
  assert.equal(decideVerification({ filesWritten: ['README.md'], shellWroteUnknown: true, verified: false, alreadyNudged: false }), 'verify');
});

test('shouldNudgeVerification: only when mutated && not verified && not nudged', () => {
  assert.equal(shouldNudgeVerification({ mutated: true, verified: false, alreadyNudged: false }), true);
  assert.equal(shouldNudgeVerification({ mutated: true, verified: true, alreadyNudged: false }), false);
  assert.equal(shouldNudgeVerification({ mutated: false, verified: false, alreadyNudged: false }), false);
  assert.equal(shouldNudgeVerification({ mutated: true, verified: false, alreadyNudged: true }), false);
});

test('buildVerificationNudge: demands a check and allows a justified skip', () => {
  const m = buildVerificationNudge();
  assert.match(m, /verification guardrail/i);
  assert.match(m, /build, test, typecheck/);
  assert.match(m, /docs-only/);
});

test('buildDocsOnlyVerificationNote: names the files + asks for an explicit statement', () => {
  const m = buildDocsOnlyVerificationNote(['README.md', 'CHANGELOG.md']);
  assert.match(m, /documentation \/ configuration/i);
  assert.match(m, /README\.md/);
  assert.match(m, /no verification was required/i);
});

// --- runTurn integration ----------------------------------------------------

test('runTurn: verification gate nudges an edit-then-done turn into verifying', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let sawNudge = false;
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello\n');
      globalThis.fetch = (async (_url: any, opts: any) => {
        const body = JSON.parse(opts.body);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        calls++;
        if (calls === 1) {
          // read then edit, in one assistant message
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [
                  { id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } },
                  { id: 'e1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a.txt', targetContent: 'hello', replacementContent: 'hi' }) } },
                ],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (calls === 2) {
          // Declare done with NO verification → gate must fire.
          return new Response(JSON.stringify({
            choices: [{ message: { content: 'Done — edited a.txt.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        sawNudge = messages.some((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('verification guardrail'));
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Verified — the change is correct (no test suite in this workspace).' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;

      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, accessMode: 'shell',
      });
      const answer = await agent.runTurn('change hello to hi in a.txt', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      } as any);
      assert.equal(sawNudge, true, 'verification nudge injected before the final reply');
      assert.match(answer, /Verified/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn: a DOCS-ONLY edit gets the no-verification-required note, not the verify nudge', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let sawVerifyGuardrail = false;
    let sawDocsOnly = false;
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(path.join(workspace, 'README.md'), '# Title\n\nold\n');
      globalThis.fetch = (async (_url: any, opts: any) => {
        const body = JSON.parse(opts.body);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({
            choices: [{ message: { content: '', tool_calls: [
              { id: 'e1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'README.md', targetContent: 'old', replacementContent: 'new' }) } },
            ] } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (calls === 2) {
          return new Response(JSON.stringify({
            choices: [{ message: { content: 'Done — updated the README.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        for (const m of messages) {
          if (m.role === 'user' && typeof m.content === 'string') {
            if (m.content.includes('verification guardrail')) sawVerifyGuardrail = true;
            if (/no verification was required/i.test(m.content)) sawDocsOnly = true;
          }
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'No verification was required — this was a docs-only change.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;

      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, accessMode: 'shell',
      });
      await agent.runTurn('update the README', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      } as any);
      assert.equal(sawDocsOnly, true, 'docs-only note injected for a markdown-only change');
      assert.equal(sawVerifyGuardrail, false, 'the verify guardrail must NOT fire for docs-only');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
