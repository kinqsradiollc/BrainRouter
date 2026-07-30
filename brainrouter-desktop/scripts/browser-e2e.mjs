#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  booleanGate,
  defaultReportPath,
  environmentMetadata,
  finalizeReport,
  gate,
  parseHarnessArgs,
  printGateSummary,
  skippedGate,
  summarize,
  writeJsonReport,
} from './browser-benchmark-lib.mjs';
import {
  chromiumMajor,
  delay,
  launchElectron,
  processTreeSample,
  runRendererProgram,
  startFixtureServer,
} from './browser-harness.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let options;
try {
  options = parseHarnessArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (options.help) {
  console.log(`Usage: node scripts/browser-e2e.mjs [options]

  --runs N          blank-tab sample count (default: 20)
  --switches N      tab switches (default: 1000)
  --cycles N        create/close cycles (default: 100)
  --max-tabs N      maximum tab lifecycle point, 20-50 (default: 50)
  --electron-app P  packaged .app or executable instead of the development build
  --report P        JSON report destination
  --quick           diagnostic 3-run/20-switch/5-cycle/20-tab run
`);
  process.exit(0);
}

const reportFile = options.report || defaultReportPath(desktopRoot, 'browser-e2e-latest.json');
const fixture = await startFixtureServer();
let electron = null;
let executionError = null;
let measurements = null;

try {
  electron = await launchElectron({ desktopRoot, electronApp: options.electronApp });
  const prepared = await runRendererProgram(electron, prepareBrowser, { origin: fixture.origin });
  const oneTabResources = await settledProcessSample(electron.pid);

  const micro = await runRendererProgram(electron, measureBridgeAndBlankTabs, { runs: options.runs });
  const twenty = await runRendererProgram(electron, createTabSet, { origin: fixture.origin, targetCount: 20 });
  const twentyTabResources = await settledProcessSample(electron.pid);
  const retention = await runRendererProgram(electron, measureRetentionAndSwitches, {
    switches: options.switches,
    retainedValue: `brainrouter-retained-${Date.now()}`,
  });
  const stress = await runRendererProgram(electron, runTabStress, {
    origin: fixture.origin,
    maxTabs: options.maxTabs,
    cycles: options.cycles,
    completedSwitches: retention.switchCount,
  }, 240_000);
  const afterStressResources = await settledProcessSample(electron.pid);

  measurements = {
    prepared,
    blankTabCreationMs: summarize(micro.blankTabCreationMs),
    bridgeDispatchMs: summarize(micro.bridgeDispatchMs),
    bridgeDispatchRuns: micro.bridgeDispatchMs.length,
    oneTabResources,
    twentyTabResources,
    twenty,
    warmTabSwitchMs: summarize(retention.switchMs),
    retention,
    stress,
    afterStressResources,
  };
} catch (error) {
  executionError = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
} finally {
  if (electron) await electron.stop();
  await fixture.close();
}

const gates = [];
if (executionError || !measurements) {
  gates.push(booleanGate({ id: 'e2e.execution', description: 'Real Electron harness completed', passed: false }));
} else {
  const maxTabReleaseRun = options.maxTabs === 50;
  const fullSwitchRun = options.switches >= 1_000;
  const fullCycleRun = options.cycles >= 100;
  gates.push(
    booleanGate({ id: 'e2e.execution', description: 'Real Electron harness completed', passed: true }),
    booleanGate({ id: 'fixture.loopback-only', description: 'Fixture used no external public service', passed: fixture.externalNetwork === false }),
    booleanGate({ id: 'tabs.one', description: 'One native tab initialized', passed: measurements.prepared.tabCount === 1 }),
    booleanGate({ id: 'tabs.twenty', description: 'Twenty native tabs loaded', passed: measurements.twenty.tabCount === 20 && measurements.twenty.loadingCount === 0 }),
    maxTabReleaseRun
      ? booleanGate({ id: 'tabs.fifty', description: 'Fifty native tabs loaded', passed: measurements.stress.maxTabCount === 50 })
      : skippedGate('tabs.fifty', 'Fifty native tabs loaded', `diagnostic run requested maxTabs=${options.maxTabs}; rerun without --quick`),
    gate({
      id: 'blank-tab.p95',
      description: 'Blank tab creation p95',
      actual: measurements.blankTabCreationMs?.p95,
      threshold: 250,
      unit: 'ms',
    }),
    gate({
      id: 'tab-switch.p95',
      description: 'Warm native tab switch p95',
      actual: measurements.warmTabSwitchMs?.p95,
      threshold: 100,
      unit: 'ms',
    }),
    gate({
      id: 'bridge-dispatch.p95',
      description: 'Browser command bridge dispatch p95 excluding page/network work',
      actual: measurements.bridgeDispatchMs?.p95,
      threshold: 50,
      unit: 'ms',
    }),
    booleanGate({
      id: 'same-tab.retention',
      description: 'Automation changed and retained state in the exact active native tab',
      passed: measurements.retention.retained === true && measurements.retention.activeTabId === measurements.retention.firstTabId,
    }),
    booleanGate({
      id: 'same-tab.no-reload',
      description: 'Warm switching preserved the tab URL, form value, and scroll state',
      passed: measurements.retention.noReload === true && measurements.retention.scrollRetained === true,
    }),
    fullSwitchRun
      ? booleanGate({ id: 'stability.switches', description: '1,000 switches completed without a crash', passed: measurements.stress.switchCount >= 1_000 && measurements.stress.crashedTabs === 0 })
      : skippedGate('stability.switches', '1,000 switches completed without a crash', `diagnostic run requested switches=${options.switches}; rerun without --quick`),
    fullCycleRun
      ? booleanGate({ id: 'stability.cycles', description: '100 create/close cycles completed without ID reuse or tab leakage', passed: measurements.stress.cycleCount >= 100 && measurements.stress.uniqueCycleIds === measurements.stress.cycleCount && measurements.stress.finalTabCount === 20 })
      : skippedGate('stability.cycles', '100 create/close cycles completed without ID reuse or tab leakage', `diagnostic run requested cycles=${options.cycles}; rerun without --quick`),
    skippedGate(
      'twenty-tabs.resource-ratio',
      'Twenty-tab incremental RSS and idle CPU relative to Chrome/Edge',
      'E2E saved Electron resource samples; run bench:browser:compare on the stable runner to enforce the same-hardware ratio',
    ),
  );
}

const report = finalizeReport({
  kind: 'brainrouter-browser-electron-e2e',
  command: 'npm run test:browser:e2e -w brainrouter-desktop',
  environment: environmentMetadata({
    electronRuntime: electron?.version?.Browser || null,
    electronChromiumMajor: chromiumMajor(electron?.version),
    electronLaunch: electron?.launch || null,
  }),
  fixture: { transport: 'http', host: '127.0.0.1', externalNetwork: fixture.externalNetwork },
  config: {
    runs: options.runs,
    switches: options.switches,
    cycles: options.cycles,
    maxTabs: options.maxTabs,
  },
  metrics: measurements,
  error: executionError,
  gates,
});

writeJsonReport(reportFile, report);
printGateSummary(report);
console.log(`Report: ${reportFile}`);
if (report.summary.fail > 0) process.exitCode = 1;

async function settledProcessSample(pid) {
  await delay(750);
  return processTreeSample(pid, { samples: 3, intervalMs: 250 });
}

async function prepareBrowser({ origin }) {
  const api = globalThis.brainrouter?.browser;
  if (!api?.getState || !api?.command || !api?.setSurface) throw new Error('BrainRouter browser preload bridge is unavailable');
  const call = async (command) => {
    const result = await api.command(command);
    if (!result?.ok) throw new Error(`${command.op} failed: ${result?.code || 'UNKNOWN'} ${result?.error || ''}`);
    return result;
  };
  const waitFor = async (predicate, label, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await api.getState();
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  api.setSurface({ x: 300, y: 170, width: 900, height: 620, visible: true });
  let state = await api.getState();
  for (const tab of state.tabs.slice(1)) await call({ op: 'close-tab', tabId: tab.id });
  state = await api.getState();
  const first = state.tabs[0];
  if (!first) throw new Error('browser manager created no initial tab');
  await call({ op: 'select-tab', tabId: first.id });
  await call({ op: 'navigate', url: `${origin}/fixture?id=primary` });
  state = await waitFor(
    (candidate) => candidate.tabs.length === 1 && candidate.tabs[0]?.url.includes('/fixture?id=primary') && candidate.tabs[0]?.loading === false && candidate.tabs[0]?.title.startsWith('Fixture'),
    'the one-tab local fixture',
  );
  globalThis.__brainrouterBenchmarkLongTasks = [];
  try {
    const observer = new PerformanceObserver((list) => globalThis.__brainrouterBenchmarkLongTasks.push(...list.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: 'longtask', buffered: true });
    globalThis.__brainrouterBenchmarkObserver = observer;
  } catch { /* long-task observer is optional evidence */ }
  return { tabCount: state.tabs.length, firstTabId: state.tabs[0].id, capabilities: state.capabilities };
}

async function measureBridgeAndBlankTabs({ runs }) {
  const api = globalThis.brainrouter.browser;
  const call = async (command) => {
    const result = await api.command(command);
    if (!result?.ok) throw new Error(`${command.op} failed: ${result?.code || 'UNKNOWN'} ${result?.error || ''}`);
    return result;
  };
  const blankTabCreationMs = [];
  const ids = new Set();
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const created = await call({ op: 'create-tab', active: false });
    blankTabCreationMs.push(performance.now() - started);
    const id = created.value?.id;
    if (!id || ids.has(id)) throw new Error('blank tab creation reused or omitted a tab id');
    ids.add(id);
    await call({ op: 'close-tab', tabId: id });
  }
  const bridgeDispatchMs = [];
  const dispatchRuns = Math.max(20, runs * 10);
  for (let index = 0; index < dispatchRuns; index += 1) {
    const started = performance.now();
    await call({ op: 'state' });
    bridgeDispatchMs.push(performance.now() - started);
  }
  return { blankTabCreationMs, bridgeDispatchMs };
}

async function createTabSet({ origin, targetCount }) {
  const api = globalThis.brainrouter.browser;
  const call = async (command) => {
    const result = await api.command(command);
    if (!result?.ok) throw new Error(`${command.op} failed: ${result?.code || 'UNKNOWN'} ${result?.error || ''}`);
    return result;
  };
  let state = await api.getState();
  for (let index = state.tabs.length; index < targetCount; index += 1) {
    await call({ op: 'create-tab', url: `${origin}/fixture?id=${index}`, active: false });
  }
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    state = await api.getState();
    const ready = state.tabs.length === targetCount
      && state.tabs.every((tab) => tab.loading === false && tab.title.startsWith('Fixture'));
    if (ready) return { tabCount: state.tabs.length, loadingCount: 0, ids: state.tabs.map((tab) => tab.id) };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out loading ${targetCount} fixture tabs`);
}

async function measureRetentionAndSwitches({ switches, retainedValue }) {
  const api = globalThis.brainrouter.browser;
  const call = async (command) => {
    const result = await api.command(command);
    if (!result?.ok) throw new Error(`${command.op} failed: ${result?.code || 'UNKNOWN'} ${result?.error || ''}`);
    return result;
  };
  // BrowserPanel may report its hidden state after the initial preload probe.
  // Re-assert a concrete native surface immediately before the input/scroll
  // retention test so this measures a visible WebContentsView, not a detached
  // background page with a zero-sized viewport.
  const benchmarkSurface = { x: 300, y: 170, width: 900, height: 620, visible: true };
  const surfaceReady = (candidate) => (
    candidate?.visible === true
    && candidate.width > 1
    && candidate.height > 1
  );
  api.setSurface(benchmarkSurface);
  await new Promise((resolve) => setTimeout(resolve, 50));
  let state = await api.getState();
  const first = state.tabs[0], second = state.tabs[1];
  if (!first || !second) throw new Error('retention test requires two tabs');
  await call({ op: 'select-tab', tabId: first.id });
  const selectionDeadline = Date.now() + 10_000;
  let selectedSnapshot;
  let lastSurfaceAttempt = 0;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await api.getState();
    if (!surfaceReady(state.surface) && Date.now() - lastSurfaceAttempt >= 250) {
      api.setSurface(benchmarkSurface);
      lastSurfaceAttempt = Date.now();
      state = await api.getState();
    }
    selectedSnapshot = await call({ op: 'snapshot', mode: 'testids' });
  } while (
    Date.now() < selectionDeadline
    && (
      state.activeTabId !== first.id
      || !surfaceReady(state.surface)
      || !selectedSnapshot.value?.nodes?.some((node) => node.testid === 'fixture-heading')
    )
  );
  if (
    state.activeTabId !== first.id
    || !surfaceReady(state.surface)
    || !selectedSnapshot.value?.nodes?.some((node) => node.testid === 'fixture-heading')
  ) {
    const testids = selectedSnapshot.value?.nodes
      ?.map((node) => node.testid)
      .filter(Boolean)
      .slice(0, 10)
      .join(',') || 'none';
    throw new Error(
      `retention tab did not become active and snapshot-ready (active=${String(state.activeTabId)}, expected=${first.id}, visible=${String(state.surface?.visible)}, testids=${testids})`,
    );
  }
  const originalUrl = first.url;
  await call({ op: 'type', target: 'retained-input', text: retainedValue, replace: true });
  await call({ op: 'scroll', x: 450, y: 310, deltaY: 1_200 });
  // A CDP wheel scroll settles over a compositor frame and the fixture updates
  // its scroll-state <output> from a 'scroll' listener, so the baseline is not
  // observable synchronously. Poll the snapshot until the input value committed
  // AND a non-zero scroll registered before capturing the baseline — otherwise
  // we'd measure a premature read (scroll:0) rather than true state retention.
  // If retention were genuinely broken this simply times out and the gate fails.
  const parseScrollY = (value) => Number(
    /scroll:(\d+)/.exec(String(typeof value === 'string' ? value : value?.name || ''))?.[1] || 0,
  );
  let before, beforeInput, beforeScroll;
  let beforeScrollYObserved = 0;
  let previousBaselineScrollY = 0;
  let stableBaselineReads = 0;
  const baselineDeadline = Date.now() + 10_000;
  let lastScrollAttempt = 0;
  let lastTypeAttempt = 0;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await api.getState();
    if (!surfaceReady(state.surface) && Date.now() - lastSurfaceAttempt >= 250) {
      api.setSurface(benchmarkSurface);
      lastSurfaceAttempt = Date.now();
    }
    before = await call({ op: 'snapshot', mode: 'testids' });
    beforeInput = before.value?.nodes?.find((node) => node.testid === 'retained-input');
    beforeScroll = before.value?.nodes?.find((node) => node.testid === 'scroll-state');
    const activeTitle = state.tabs.find((tab) => tab.id === first.id)?.title;
    beforeScrollYObserved = Math.max(parseScrollY(beforeScroll), parseScrollY(activeTitle));
    if (beforeInput?.value === retainedValue && beforeScrollYObserved > 0) {
      stableBaselineReads = beforeScrollYObserved === previousBaselineScrollY
        ? stableBaselineReads + 1
        : 1;
      previousBaselineScrollY = beforeScrollYObserved;
    } else {
      stableBaselineReads = 0;
    }
    if (beforeInput?.value !== retainedValue && Date.now() - lastTypeAttempt >= 250) {
      await call({ op: 'type', target: 'retained-input', text: retainedValue, replace: true });
      lastTypeAttempt = Date.now();
    }
    if (beforeScrollYObserved === 0 && Date.now() - lastScrollAttempt >= 250) {
      await call({ op: 'scroll', x: 450, y: 310, deltaY: 1_200 });
      lastScrollAttempt = Date.now();
    }
  } while (Date.now() < baselineDeadline && stableBaselineReads < 3);
  if (beforeInput?.value !== retainedValue || beforeScrollYObserved === 0 || stableBaselineReads < 3) {
    const activeTitle = state.tabs.find((tab) => tab.id === first.id)?.title;
    throw new Error(
      `retention baseline did not settle (input=${String(beforeInput?.value ?? '')}, snapshotScroll=${parseScrollY(beforeScroll)}, stableReads=${stableBaselineReads}, title=${String(activeTitle ?? '')})`,
    );
  }
  const switchMs = [];
  for (let index = 0; index < switches; index += 1) {
    const id = index % 2 === 0 ? second.id : first.id;
    const started = performance.now();
    await call({ op: 'select-tab', tabId: id });
    switchMs.push(performance.now() - started);
  }
  await call({ op: 'select-tab', tabId: first.id });
  const beforeScrollY = beforeScrollYObserved;
  const finalDeadline = Date.now() + 10_000;
  let afterInput, afterScroll, active;
  let afterScrollY = 0;
  let finalStateReady = false;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await api.getState();
    if (state.activeTabId !== first.id) {
      await call({ op: 'select-tab', tabId: first.id });
      continue;
    }
    if (!surfaceReady(state.surface) && Date.now() - lastSurfaceAttempt >= 250) {
      api.setSurface(benchmarkSurface);
      lastSurfaceAttempt = Date.now();
      continue;
    }
    const after = await call({ op: 'snapshot', mode: 'testids' });
    afterInput = after.value?.nodes?.find((node) => node.testid === 'retained-input');
    afterScroll = after.value?.nodes?.find((node) => node.testid === 'scroll-state');
    active = state.tabs.find((tab) => tab.id === state.activeTabId);
    afterScrollY = Math.max(parseScrollY(afterScroll), parseScrollY(active?.title));
    finalStateReady = (
      afterInput?.value === retainedValue
      && active?.url === originalUrl
      && Math.abs(beforeScrollY - afterScrollY) <= 2
    );
  } while (Date.now() < finalDeadline && !finalStateReady);
  return {
    switchMs,
    switchCount: switches,
    firstTabId: first.id,
    activeTabId: state.activeTabId,
    retained: beforeInput?.value === retainedValue && afterInput?.value === retainedValue,
    scrollRetained: beforeScrollY > 0 && afterScrollY > 0 && Math.abs(beforeScrollY - afterScrollY) <= 2,
    beforeScrollY,
    afterScrollY,
    noReload: active?.url === originalUrl,
    originalUrl,
    finalUrl: active?.url,
    surface: state.surface,
  };
}

async function runTabStress({ origin, maxTabs, cycles, completedSwitches }) {
  const api = globalThis.brainrouter.browser;
  const call = async (command) => {
    const result = await api.command(command);
    if (!result?.ok) throw new Error(`${command.op} failed: ${result?.code || 'UNKNOWN'} ${result?.error || ''}`);
    return result;
  };
  let state = await api.getState();
  for (let index = state.tabs.length; index < maxTabs; index += 1) {
    await call({ op: 'create-tab', url: `${origin}/fixture?id=stress-${index}`, active: false });
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    state = await api.getState();
    if (state.tabs.length === maxTabs && state.tabs.every((tab) => tab.loading === false && tab.title.startsWith('Fixture'))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (state.tabs.length !== maxTabs || state.tabs.some((tab) => tab.loading || !tab.title.startsWith('Fixture'))) {
    throw new Error(`timed out loading the ${maxTabs}-tab stress set`);
  }
  const maxTabCount = state.tabs.length;
  for (const tab of state.tabs.slice(20).reverse()) await call({ op: 'close-tab', tabId: tab.id });
  state = await api.getState();
  const cycleIds = new Set();
  for (let index = 0; index < cycles; index += 1) {
    const created = await call({ op: 'create-tab', active: false });
    const id = created.value?.id;
    if (!id || cycleIds.has(id)) throw new Error(`tab id was reused during create/close cycle ${index}`);
    cycleIds.add(id);
    await call({ op: 'close-tab', tabId: id });
  }
  state = await api.getState();
  return {
    maxTabCount,
    switchCount: completedSwitches,
    cycleCount: cycles,
    uniqueCycleIds: cycleIds.size,
    finalTabCount: state.tabs.length,
    crashedTabs: state.tabs.filter((tab) => tab.crashed).length,
    longTasksMs: Array.isArray(globalThis.__brainrouterBenchmarkLongTasks) ? globalThis.__brainrouterBenchmarkLongTasks.slice(-500) : null,
  };
}
