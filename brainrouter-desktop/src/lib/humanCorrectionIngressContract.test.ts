/**
 * ADR-032 D1/D8 — source contract for the explicit, non-model correction path.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('Desktop correction ingress is an explicit UI action routed through the host-owned recorder port', () => {
  const host = read('../../electron/host.ts');
  const hostCore = read('../../electron/hostCore.ts');
  const hostQueries = read('../../electron/host/queries.ts');
  const settings = read('../../src/settings.tsx');
  const form = read('../../src/settings/memory/LearnedBehaviorSettings.tsx');
  const devBridge = read('../../src/devBridge/queries.ts');
  const results = read('./agent/useAgentEvents/handleQueryResult.ts');

  assert.match(host, /recordHumanCorrection[^;]*from '@kinqs\/brainrouter-core\/learning'/);
  assert.match(host, /createAuthenticatedHumanCorrectionIngress\(\{[\s\S]{0,900}record:\s*recordHumanCorrection/);
  assert.match(host, /initialDesktopLearningBinding\(desktopLearningIdentityConfig\(config\)\)/);
  assert.match(host, /resolveDesktopLearningBinding\(\{[\s\S]{0,180}mcpClient/);
  assert.match(host, /accountUserId:\s*learningBinding\.tenant\.userId[\s\S]{0,220}tenant:\s*activeAgent\.learnedTenant[\s\S]{0,180}bindingError:\s*activeTenantBindingError/);
  assert.match(host, /hostTransportMatches[\s\S]{0,180}boundBrainOrgId/);
  assert.match(hostQueries, /'action:learning-correct':\s*\(args\)\s*=>\s*humanCorrectionIngress\.record\(args\)/);
  assert.match(settings, /onAction\('a-learning-correct',\s*'action:learning-correct',\s*\{\s*\.\.\.correction\s*\}\)/);
  assert.match(form, /Ordinary chat prose remains conversation and is never promoted automatically/);
  assert.match(form, /Record correction as instruction/);
  assert.match(results, /case 'a-learning-correct':[\s\S]{0,300}q\('q-snapshot',\s*'config-snapshot'\)/);
  assert.match(results, /if \(error\)[\s\S]{0,120}a-learning-correct[\s\S]{0,100}q\('q-snapshot',\s*'config-snapshot'\)/);

  const devAction = devBridge.slice(
    devBridge.indexOf("'action:learning-correct'"),
    devBridge.indexOf("'action:learning-revert'"),
  );
  assert.match(devAction, /sessionKey:\s*'dev-session'/);
  assert.doesNotMatch(devAction, /a\.(?:userId|orgId|sessionKey|tenant|tier|origin|provenance)/);

  assert.doesNotMatch(hostCore, /recordHumanCorrection|action:learning-correct/);
  assert.doesNotMatch(hostQueries, /start-turn[\s\S]{0,500}recordHumanCorrection/);
});
