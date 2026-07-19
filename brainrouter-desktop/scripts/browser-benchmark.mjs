#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  booleanGate,
  defaultReportPath,
  environmentMetadata,
  finalizeReport,
  gate,
  parseHarnessArgs,
  printGateSummary,
  ratio,
  skippedGate,
  summarize,
  writeJsonReport,
} from './browser-benchmark-lib.mjs';
import {
  chromiumMajor,
  closeChromeTab,
  createChromeTab,
  delay,
  launchComparisonBrowser,
  launchElectron,
  navigateChrome,
  processTreeSample,
  runRendererProgram,
  startFixtureServer,
} from './browser-harness.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let options;
try {
  options = parseHarnessArgs(process.argv.slice(2), { switches: 100, cycles: 20, maxTabs: 20 });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (options.help) {
  console.log(`Usage: node scripts/browser-benchmark.mjs [options]

  --runs N               navigation/tab sample count (default: 20)
  --electron-app P       packaged .app or executable instead of development build
  --browser P            Chrome/Edge executable (auto-detected when omitted)
  --enforce-comparison   enforce hardware-sensitive Chrome/Edge ratio gates
  --no-chrome            record an explicit comparison skip
  --report P             JSON report destination
  --quick                diagnostic three-run comparison

Set BRAINROUTER_BROWSER_STABLE_RUNNER=1 on the dedicated same-hardware runner.
`);
  process.exit(0);
}

const reportFile = options.report || defaultReportPath(desktopRoot, 'browser-comparison-latest.json');
const fixture = await startFixtureServer();
let electron = null;
let comparisonBrowser = null;
let electronError = null;
let comparisonError = null;
let electronMetrics = null;
let browserMetrics = null;
let electronVersion = null;
let comparisonVersion = null;
let comparisonName = null;

try {
  electron = await launchElectron({ desktopRoot, electronApp: options.electronApp });
  electronVersion = electron.version;
  const prepared = await runRendererProgram(electron, prepareComparisonElectron, { origin: fixture.origin });
  const oneTabResources = await settledProcessSample(electron.pid);
  const timings = await runRendererProgram(electron, measureElectronComparison, { origin: fixture.origin, runs: options.runs }, 180_000);
  await delay(1_000);
  const twentyTabResources = await settledProcessSample(electron.pid);
  electronMetrics = { prepared, oneTabResources, twentyTabResources, ...timings };
} catch (error) {
  electronError = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
} finally {
  if (electron) await electron.stop();
}

if (!options.noChrome) {
  try {
    comparisonBrowser = await launchComparisonBrowser({
      browserPath: options.browser,
      initialUrl: `${fixture.origin}/fixture?id=chrome-primary`,
    });
    if (comparisonBrowser) {
      comparisonName = comparisonBrowser.name;
      comparisonVersion = comparisonBrowser.version;
      await waitForChromeFixture(comparisonBrowser.pageSession);
      const oneTabResources = await settledProcessSample(comparisonBrowser.pid);
      const timings = await measureComparisonBrowser(comparisonBrowser, fixture.origin, options.runs);
      await delay(1_000);
      const twentyTabResources = await settledProcessSample(comparisonBrowser.pid);
      browserMetrics = { oneTabResources, twentyTabResources, ...timings };
    }
  } catch (error) {
    comparisonError = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
  } finally {
    if (comparisonBrowser) await comparisonBrowser.stop();
  }
}
await fixture.close();

const electronNavigation = summarize(electronMetrics?.warmNavigationMs);
const browserNavigation = summarize(browserMetrics?.warmNavigationMs);
const electronBlank = summarize(electronMetrics?.blankTabCreationMs);
const browserBlank = summarize(browserMetrics?.blankTabCreationMs);
const electronSwitch = summarize(electronMetrics?.warmTabSwitchMs);
const browserSwitch = summarize(browserMetrics?.warmTabSwitchMs);
const bridgeDispatch = summarize(electronMetrics?.bridgeDispatchMs);
const navigationMedianRatio = ratio(electronNavigation?.median, browserNavigation?.median);
const navigationP95Ratio = ratio(electronNavigation?.p95, browserNavigation?.p95);
const electronIncrementalRss = resourceDelta(electronMetrics?.oneTabResources, electronMetrics?.twentyTabResources, 'rssBytes');
const browserIncrementalRss = resourceDelta(browserMetrics?.oneTabResources, browserMetrics?.twentyTabResources, 'rssBytes');
const rssRatio = ratio(electronIncrementalRss, browserIncrementalRss);
const electronIdleCpu = supportedValue(electronMetrics?.twentyTabResources, 'cpuPercent');
const browserIdleCpu = supportedValue(browserMetrics?.twentyTabResources, 'cpuPercent');
const electronMajor = chromiumMajor(electronVersion);
const comparisonMajor = chromiumMajor(comparisonVersion);
const engineLag = Number.isFinite(electronMajor) && Number.isFinite(comparisonMajor) ? comparisonMajor - electronMajor : null;
const comparisonAvailable = Boolean(browserMetrics && comparisonVersion);
const stableEnforcement = options.enforceComparison && comparisonAvailable;
const comparisonReason = options.noChrome
  ? '--no-chrome was requested'
  : comparisonError
    ? `comparison browser failed: ${comparisonError.split('\n')[0]}`
    : !comparisonAvailable
      ? 'no local Chrome or Edge executable was found'
      : !options.enforceComparison
        ? 'observed locally but not enforced; use the stable runner or --enforce-comparison'
        : '';

const gates = [];
gates.push(
  booleanGate({ id: 'benchmark.electron', description: 'BrainRouter Electron comparison run completed', passed: !electronError && Boolean(electronMetrics) }),
  options.noChrome || !comparisonAvailable
    ? (options.enforceComparison
      ? booleanGate({ id: 'benchmark.comparison-browser', description: 'Chrome/Edge comparison run completed', passed: false })
      : skippedGate('benchmark.comparison-browser', 'Chrome/Edge comparison run completed', comparisonReason))
    : booleanGate({ id: 'benchmark.comparison-browser', description: 'Chrome/Edge comparison run completed', passed: true }),
);

if (electronMetrics) {
  gates.push(
    gate({ id: 'blank-tab.p95', description: 'BrainRouter blank tab creation p95', actual: electronBlank?.p95, threshold: 250, unit: 'ms' }),
    gate({ id: 'tab-switch.p95', description: 'BrainRouter warm tab switch p95', actual: electronSwitch?.p95, threshold: 100, unit: 'ms' }),
    gate({ id: 'bridge-dispatch.p95', description: 'BrainRouter bridge dispatch p95 excluding page/network work', actual: bridgeDispatch?.p95, threshold: 50, unit: 'ms' }),
    booleanGate({ id: 'tabs.twenty', description: 'Twenty BrainRouter fixture tabs loaded without crash', passed: electronMetrics.finalTabCount === 20 && electronMetrics.crashedTabs === 0 }),
  );
}

gates.push(
  gate({
    id: 'engine.chromium-major',
    description: 'Bundled Chromium is no more than one major behind local Chrome/Edge',
    actual: engineLag,
    threshold: 1,
    unit: 'major',
    enforce: comparisonAvailable,
    reason: comparisonReason,
  }),
  gate({
    id: 'navigation.median-ratio',
    description: 'Warm local navigation median relative to Chrome/Edge',
    actual: navigationMedianRatio,
    threshold: 1.1,
    unit: 'x',
    enforce: stableEnforcement,
    reason: comparisonReason,
  }),
  gate({
    id: 'navigation.p95-ratio',
    description: 'Warm local navigation p95 relative to Chrome/Edge',
    actual: navigationP95Ratio,
    threshold: 1.15,
    unit: 'x',
    enforce: stableEnforcement,
    reason: comparisonReason,
  }),
  gate({
    id: 'twenty-tabs.rss-ratio',
    description: 'Twenty-tab incremental RSS relative to Chrome/Edge',
    actual: rssRatio,
    threshold: 1.15,
    unit: 'x',
    enforce: stableEnforcement && rssRatio !== null,
    reason: rssRatio === null ? 'process-tree RSS samples were unavailable or the comparison delta was zero' : comparisonReason,
  }),
  gate({
    id: 'twenty-tabs.idle-cpu',
    description: 'Twenty-tab idle CPU is within one percentage point of Chrome/Edge',
    actual: Number.isFinite(electronIdleCpu) && Number.isFinite(browserIdleCpu) ? electronIdleCpu - browserIdleCpu : null,
    threshold: 1,
    unit: 'percentage points',
    enforce: stableEnforcement && Number.isFinite(electronIdleCpu) && Number.isFinite(browserIdleCpu),
    reason: !Number.isFinite(electronIdleCpu) || !Number.isFinite(browserIdleCpu) ? 'process-tree CPU samples were unavailable' : comparisonReason,
  }),
  skippedGate(
    'speedometer3.score-ratio',
    'Speedometer 3 score relative to Chrome/Edge',
    'Speedometer 3 is a separately scheduled standards benchmark and is not vendored; this loopback-only command will not download it or fake a score',
  ),
  skippedGate(
    'web-vitals.production',
    'Production Core Web Vitals relative to Chrome/Edge',
    'the deterministic loopback fixture is suitable for regression timing but cannot substitute for the separately scheduled representative-page Web Vitals run',
  ),
  skippedGate(
    'main-thread.long-task-attribution',
    'No unexplained interaction task over 50 ms',
    'long-task durations are saved when supported; release qualification requires a trace with task attribution on the stable runner',
  ),
);

const report = finalizeReport({
  kind: 'brainrouter-browser-chromium-comparison',
  command: 'npm run bench:browser:compare -w brainrouter-desktop -- --runs 20',
  environment: environmentMetadata({
    stableRunner: options.enforceComparison,
    electronRuntime: electronVersion?.Browser || null,
    electronChromiumMajor: electronMajor,
    comparisonBrowser: comparisonName,
    comparisonRuntime: comparisonVersion?.Browser || null,
    comparisonChromiumMajor: comparisonMajor,
  }),
  fixture: { transport: 'http', host: '127.0.0.1', externalNetwork: fixture.externalNetwork },
  config: { runs: options.runs, enforceComparison: options.enforceComparison },
  metrics: {
    electron: {
      ...electronMetrics,
      blankTabCreationMs: electronBlank,
      warmNavigationMs: electronNavigation,
      warmTabSwitchMs: electronSwitch,
      bridgeDispatchMs: bridgeDispatch,
      incrementalRssBytes: electronIncrementalRss,
      idleCpuPercent: electronIdleCpu,
    },
    comparisonBrowser: {
      ...browserMetrics,
      blankTabCreationMs: browserBlank,
      warmNavigationMs: browserNavigation,
      warmTabSwitchMs: browserSwitch,
      incrementalRssBytes: browserIncrementalRss,
      idleCpuPercent: browserIdleCpu,
    },
    ratios: {
      warmNavigationMedian: navigationMedianRatio,
      warmNavigationP95: navigationP95Ratio,
      twentyTabIncrementalRss: rssRatio,
      twentyTabIdleCpuDifference: Number.isFinite(electronIdleCpu) && Number.isFinite(browserIdleCpu) ? electronIdleCpu - browserIdleCpu : null,
    },
  },
  errors: { electron: electronError, comparisonBrowser: comparisonError },
  gates,
});

writeJsonReport(reportFile, report);
printGateSummary(report);
console.log(`Report: ${reportFile}`);
if (report.summary.fail > 0) process.exitCode = 1;

async function settledProcessSample(pid) {
  await delay(1_000);
  return processTreeSample(pid, { samples: 4, intervalMs: 300 });
}

function resourceDelta(before, after, key) {
  const first = supportedValue(before, key), second = supportedValue(after, key);
  return Number.isFinite(first) && Number.isFinite(second) ? Math.max(0, second - first) : null;
}

function supportedValue(sample, key) {
  return sample?.supported === true && Number.isFinite(sample[key]) ? sample[key] : null;
}

async function prepareComparisonElectron({ origin }) {
  const api = globalThis.brainrouter?.browser;
  if (!api?.getState || !api?.command || !api?.setSurface) throw new Error('BrainRouter browser preload bridge is unavailable');
  const call = async (command) => {
    const result = await api.command(command);
    if (!result?.ok) throw new Error(`${command.op} failed: ${result?.code || 'UNKNOWN'} ${result?.error || ''}`);
    return result;
  };
  api.setSurface({ x: 300, y: 170, width: 900, height: 620, visible: true });
  let state = await api.getState();
  for (const tab of state.tabs.slice(1)) await call({ op: 'close-tab', tabId: tab.id });
  state = await api.getState();
  await call({ op: 'select-tab', tabId: state.tabs[0].id });
  await call({ op: 'navigate', url: `${origin}/fixture?id=electron-primary` });
  globalThis.__brainrouterBenchmarkLongTasks = [];
  try {
    const observer = new PerformanceObserver((list) => globalThis.__brainrouterBenchmarkLongTasks.push(...list.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: 'longtask', buffered: true });
    globalThis.__brainrouterBenchmarkObserver = observer;
  } catch { /* optional trace evidence */ }
  return { tabCount: (await api.getState()).tabs.length };
}

async function measureElectronComparison({ origin, runs }) {
  const api = globalThis.brainrouter.browser;
  const call = async (command) => {
    const result = await api.command(command);
    if (!result?.ok) throw new Error(`${command.op} failed: ${result?.code || 'UNKNOWN'} ${result?.error || ''}`);
    return result;
  };
  const blankTabCreationMs = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const created = await call({ op: 'create-tab', active: false });
    blankTabCreationMs.push(performance.now() - started);
    await call({ op: 'close-tab', tabId: created.value.id });
  }
  const bridgeDispatchMs = [];
  for (let index = 0; index < Math.max(20, runs * 10); index += 1) {
    const started = performance.now();
    await call({ op: 'state' });
    bridgeDispatchMs.push(performance.now() - started);
  }
  const warmNavigationMs = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await call({ op: 'navigate', url: `${origin}/fixture?id=electron-nav-${index}` });
    warmNavigationMs.push(performance.now() - started);
  }
  let state = await api.getState();
  for (let index = state.tabs.length; index < 20; index += 1) {
    await call({ op: 'create-tab', url: `${origin}/fixture?id=electron-tab-${index}`, active: false });
  }
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    state = await api.getState();
    if (state.tabs.length === 20 && state.tabs.every((tab) => !tab.loading && tab.title.startsWith('Fixture'))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (state.tabs.length !== 20 || state.tabs.some((tab) => tab.loading || !tab.title.startsWith('Fixture'))) throw new Error('twenty Electron tabs did not finish loading');
  const first = state.tabs[0].id, second = state.tabs[1].id;
  const warmTabSwitchMs = [];
  for (let index = 0; index < Math.max(20, runs * 5); index += 1) {
    const started = performance.now();
    await call({ op: 'select-tab', tabId: index % 2 ? first : second });
    warmTabSwitchMs.push(performance.now() - started);
  }
  state = await api.getState();
  return {
    blankTabCreationMs,
    bridgeDispatchMs,
    warmNavigationMs,
    warmTabSwitchMs,
    finalTabCount: state.tabs.length,
    crashedTabs: state.tabs.filter((tab) => tab.crashed).length,
    longTasksMs: Array.isArray(globalThis.__brainrouterBenchmarkLongTasks) ? globalThis.__brainrouterBenchmarkLongTasks.slice(-500) : null,
  };
}

async function waitForChromeFixture(pageSession) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await pageSession.evaluate('Boolean(globalThis.__brainrouterFixtureReady)', 3_000).catch(() => false)) return;
    await delay(50);
  }
  throw new Error('comparison browser did not load the local fixture');
}

async function measureComparisonBrowser(browser, origin, runs) {
  const blankTabCreationMs = [];
  for (let index = 0; index < runs; index += 1) {
    const created = await createChromeTab(browser.browserSession, 'about:blank');
    blankTabCreationMs.push(created.durationMs);
    await closeChromeTab(browser.browserSession, created.targetId);
  }
  const warmNavigationMs = [];
  for (let index = 0; index < runs; index += 1) {
    warmNavigationMs.push(await navigateChrome(browser.pageSession, `${origin}/fixture?id=chrome-nav-${index}`));
  }
  const targetIds = [browser.pageTargetId];
  for (let index = 1; index < 20; index += 1) {
    const created = await createChromeTab(browser.browserSession, `${origin}/fixture?id=chrome-tab-${index}`);
    targetIds.push(created.targetId);
  }
  await delay(1_000);
  const warmTabSwitchMs = [];
  for (let index = 0; index < Math.max(20, runs * 5); index += 1) {
    const targetId = targetIds[index % 2];
    const started = performance.now();
    await browser.browserSession.request('Target.activateTarget', { targetId });
    warmTabSwitchMs.push(performance.now() - started);
  }
  return { blankTabCreationMs, warmNavigationMs, warmTabSwitchMs, finalTabCount: targetIds.length };
}
