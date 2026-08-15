/**
 * ADR-040 — private provider/role routing capture for reviewed execution.
 * Routing changes and even restored file edits revoke old review, while secret
 * values stay outside the content-derived fingerprint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetCliKnobsCache,
  getConfigPath,
  saveConfig,
  type Config,
} from '../config/config.js';
import {
  executionRoutingPolicyFingerprint,
  executionRoutingPolicyFingerprintFor,
} from '../orchestration/execution/routingPolicy.js';
import { scoreBuildExecution } from '../workflow/template/workflowTool.js';
import type { OrchestrationContext } from '../orchestration/tools.js';
import type { PhasePlan } from '../orchestration/workflow/phasePlan.js';
import type { PhasePlanExecution } from '../orchestration/workflow/phaseOrchestrator.js';

const REVISION = Object.freeze({
  path: '/private/config.json',
  exists: true,
  device: '1',
  inode: '2',
  size: '3',
  modifiedNs: '4',
  changedNs: '5',
});

function config(apiKey = 'secret-a'): Config {
  return {
    activeServer: '',
    servers: {},
    providers: {
      reviewed: {
        provider: 'openai',
        apiKey,
        model: 'child-model',
        endpoint: 'https://reviewed.invalid/v1',
        models: ['child-model', 'critic-model'],
      },
    },
    agentModels: {
      worker: { provider: 'reviewed', model: 'child-model' },
      critic: { provider: 'reviewed', model: 'critic-model' },
    },
    cli: {
      router: {
        order: ['reviewed'],
        chain: ['reviewed/child-model'],
      },
    },
  };
}

test('ADR-040 routing fingerprint binds providers, role assignments, and router policy but not API-key values', () => {
  const baseline = executionRoutingPolicyFingerprintFor(config(), REVISION);
  assert.equal(
    executionRoutingPolicyFingerprintFor(config('different-secret'), REVISION),
    baseline,
    'credential values never enter the content-derived routing fingerprint',
  );

  const providerChanged = config();
  providerChanged.providers!.reviewed.model = 'other-child';
  assert.notEqual(executionRoutingPolicyFingerprintFor(providerChanged, REVISION), baseline);

  const assignmentChanged = config();
  assignmentChanged.agentModels!.worker = {
    provider: 'reviewed',
    model: 'critic-model',
  };
  assert.notEqual(executionRoutingPolicyFingerprintFor(assignmentChanged, REVISION), baseline);

  const routerChanged = config();
  routerChanged.cli!.router!.order = ['alternate', 'reviewed'];
  assert.notEqual(executionRoutingPolicyFingerprintFor(routerChanged, REVISION), baseline);
});

test('ADR-040 live routing capture observes an A-to-B-to-A config edit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-routing-policy-'));
  const previousConfigDir = process.env.BRAINROUTER_CONFIG_DIR;
  process.env.BRAINROUTER_CONFIG_DIR = directory;
  _resetCliKnobsCache();
  const reviewed = config();
  const alternate = config();
  alternate.agentModels!.worker = {
    provider: 'reviewed',
    model: 'critic-model',
  };

  try {
    saveConfig(reviewed);
    const before = executionRoutingPolicyFingerprint();
    saveConfig(alternate);
    const during = executionRoutingPolicyFingerprint();
    const replaced = `${getConfigPath()}.previous`;
    fs.renameSync(getConfigPath(), replaced);
    saveConfig(reviewed);
    fs.rmSync(replaced, { force: true });
    const restored = executionRoutingPolicyFingerprint();

    assert.notEqual(during, before);
    assert.notEqual(
      restored,
      before,
      'the file revision prevents restored routing content from reviving old review',
    );
  } finally {
    _resetCliKnobsCache();
    if (previousConfigDir === undefined) delete process.env.BRAINROUTER_CONFIG_DIR;
    else process.env.BRAINROUTER_CONFIG_DIR = previousConfigDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ADR-040 a routing edit during the build-critic await revokes its verdict', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-routing-critic-'));
  const previousConfigDir = process.env.BRAINROUTER_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  process.env.BRAINROUTER_CONFIG_DIR = directory;
  _resetCliKnobsCache();
  const reviewed = config();
  const alternate = config();
  alternate.agentModels!.critic = {
    provider: 'reviewed',
    model: 'child-model',
  };

  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let requestedUrl = '';
  let requestedModel = '';

  try {
    saveConfig(reviewed);
    const reviewedFingerprint = executionRoutingPolicyFingerprint();
    const assertAuthorityCurrent = () => {
      if (executionRoutingPolicyFingerprint() !== reviewedFingerprint) {
        throw new Error('Reviewed model routing was revoked.');
      }
    };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedModel = String(JSON.parse(String(init?.body ?? '{}')).model ?? '');
      requestStarted();
      await responseGate;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{
              function: { arguments: '{"score":1,"diagnostics":[]}' },
            }],
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const execution: PhasePlanExecution = {
      status: 'completed',
      phases: [
        { id: 'implement', title: 'Implement', status: 'completed', children: [], output: 'done' },
        { id: 'verify', title: 'Verify', status: 'completed', children: [], output: 'PASS' },
      ],
    };
    const plan: PhasePlan = {
      title: 'Bounded build',
      phases: [{
        id: 'implement',
        title: 'Implement',
        agents: [{ role: 'worker', prompt: 'Implement the reviewed task.' }],
      }],
    };
    const scorePromise = scoreBuildExecution(
      execution,
      plan,
      directory,
      {
        llmConfig: {
          provider: 'openai',
          apiKey: 'parent-key',
          model: 'parent-model',
          endpoint: 'https://parent.invalid/v1',
        },
      } as OrchestrationContext,
      '',
      assertAuthorityCurrent,
    );

    await started;
    saveConfig(alternate);
    const replaced = `${getConfigPath()}.previous`;
    fs.renameSync(getConfigPath(), replaced);
    saveConfig(reviewed);
    fs.rmSync(replaced, { force: true });
    releaseResponse();

    await assert.rejects(scorePromise, /model routing was revoked/i);
    assert.equal(requestedUrl, 'https://reviewed.invalid/v1/chat/completions');
    assert.equal(requestedModel, 'critic-model');
  } finally {
    releaseResponse?.();
    globalThis.fetch = originalFetch;
    _resetCliKnobsCache();
    if (previousConfigDir === undefined) delete process.env.BRAINROUTER_CONFIG_DIR;
    else process.env.BRAINROUTER_CONFIG_DIR = previousConfigDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
