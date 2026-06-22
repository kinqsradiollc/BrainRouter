import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPromptService, PromptService } from '../prompt/service.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from '../prompt/systemPrompt.js';

test('PromptService is a stateless facade — delegates to the system-prompt builder', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-svc-'));
  try {
    const svc = createPromptService();
    assert.ok(svc instanceof PromptService);

    const ctx = { workspaceRoot: ws, launchCwd: ws, sessionKey: 's1' };
    const prompt = svc.build(ctx);
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 0);
    assert.equal(svc.build(ctx), buildSystemPrompt(ctx));

    assert.equal(svc.loadWorkspaceInstructionSummary(ws), loadWorkspaceInstructionSummary(ws));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
