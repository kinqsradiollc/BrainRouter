#!/usr/bin/env node
/**
 * ADR-038 cross-host Planner visual and usability gate.
 *
 * The Dashboard and a real Electron renderer consume the same deterministic
 * 20-item fixture. This harness checks the promises that are otherwise easy to
 * lose in screenshots: density, overflow, names, focus, contrast, currentness,
 * capture, completion, calendar movement, source opening, and targeted retry.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPlannerFixture } from '@kinqs/brainrouter-ui/planner';
import { createWorkspaceManifest, saveWorkspaceManifest } from '@kinqs/brainrouter-core/workspace';

import {
  delay,
  launchComparisonBrowser,
  launchElectron,
  navigateChrome,
} from './browser-harness.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '..');
const DEFAULT_OUTPUT = path.join(desktopRoot, '.planner-visual');
const API_PORT = 3747;
const WAIT_MS = 12_000;

const options = parseArgs(process.argv.slice(2));
const outputRoot = path.resolve(options.output ?? DEFAULT_OUTPUT);
fs.mkdirSync(outputRoot, { recursive: true });

const localNow = new Date();
const today = [
  localNow.getFullYear(),
  String(localNow.getMonth() + 1).padStart(2, '0'),
  String(localNow.getDate()).padStart(2, '0'),
].join('-');
const fixture = createPlannerFixture(today);
const report = {
  kind: 'adr-038-planner-visual-usability',
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  fixture: { date: fixture.today, itemCount: fixture.items.length, blockCount: fixture.blocks.length },
  dashboard: null,
  electron: null,
  summary: { pass: 0, fail: 0 },
};

async function main() {
  try {
    if (options.target !== 'electron') report.dashboard = await runDashboard(fixture, outputRoot);
    if (options.target !== 'dashboard') report.electron = await runElectron(fixture, outputRoot);
  } catch (error) {
    report.fatal = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  }

  const allGates = [
    ...(report.dashboard?.gates ?? []),
    ...(report.electron?.gates ?? []),
  ];
  report.summary.pass = allGates.filter((result) => result.passed).length;
  report.summary.fail = allGates.filter((result) => !result.passed).length + (report.fatal ? 1 : 0);
  const reportPath = path.join(outputRoot, `report-${process.platform}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const result of allGates) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  if (report.fatal) console.error(report.fatal);
  console.log(`Report: ${reportPath}`);
  if (report.summary.fail > 0) process.exitCode = 1;
}

function parseArgs(args) {
  let target = 'all';
  let output;
  let browserPath = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dashboard') target = 'dashboard';
    else if (arg === '--electron') target = 'electron';
    else if (arg === '--all') target = 'all';
    else if (arg === '--output') output = args[++index];
    else if (arg === '--browser') browserPath = args[++index] ?? '';
    else if (arg === '--help') {
      console.log('Usage: planner-visual-gate.mjs [--all|--dashboard|--electron] [--browser PATH] [--output DIR]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { target, output, browserPath };
}

function gate(id, passed, detail = '') {
  return { id, passed: Boolean(passed), ...(detail ? { detail } : {}) };
}

async function runDashboard(sharedFixture, destination) {
  const gates = [];
  const api = createPlannerApi(sharedFixture);
  const dashboardPort = await reservePort();
  const dashboard = startProcess(npmExecutable(), [
    'run', 'start', '-w', 'dashboard', '--', '-H', '127.0.0.1', '-p', String(dashboardPort),
  ], { cwd: repositoryRoot, label: 'Dashboard' });
  let browser;
  const screenshots = [];
  const consoleErrors = [];
  const networkErrors = [];
  try {
    const origin = `http://127.0.0.1:${dashboardPort}`;
    await waitForHttp(`${origin}/`);
    browser = await launchComparisonBrowser({
      browserPath: options.browserPath,
      initialUrl: `${origin}/`,
    });
    if (!browser) throw new Error('No Chrome or Edge installation was found for the Dashboard visual gate.');
    const page = browser.pageSession;
    await installObservation(page, consoleErrors, networkErrors);
    await api.attach(page);
    await page.request('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVATION_SCRIPT });
    // Chrome can expose the initial restricted about:blank target briefly even
    // when it was launched with an HTTP URL. Establish the Dashboard origin
    // explicitly before touching localStorage so the combined gate is as
    // deterministic as either host-only lane.
    await navigateChrome(page, `${origin}/`);
    await waitForEvaluation(
      page,
      (expectedOrigin) => location.origin === expectedOrigin,
      'Dashboard origin before storage seed',
      WAIT_MS,
      origin,
    );
    await pageProgram(page, seedDashboardBrowser, {
      jwt: visualJwt(),
      activeOrgId: 'org-visual',
      outboxKey: 'br-planner-outbox:visual-person:org-visual',
      outbox: dashboardOutbox(sharedFixture),
    });
    await navigateChrome(page, `${origin}/planner`);
    await waitForPlanner(page, 20);
    await waitFor(() => api.pushCount >= 1, 'Dashboard automatic outbox attempt');

    await setViewport(page, 1440, 900);
    const baseline = await auditPlanner(page);
    gates.push(...auditGates('dashboard.1440', baseline, { density: true, twelveVisible: true }));
    screenshots.push(await screenshot(page, destination, 'dashboard-dark-1440x900.png'));

    const sync = await exerciseSync(page, 4, async () => {
      screenshots.push(await screenshot(page, destination, 'dashboard-sync-detail.png'));
    });
    gates.push(
      gate('dashboard.sync.inspect-four', sync.issueCount === 4, `${sync.issueCount} operations shown`),
      gate('dashboard.sync.actionable-detail', sync.hasAge && sync.hasAttempts && sync.hasFailure, JSON.stringify(sync)),
      gate('dashboard.sync.targeted-retry', sync.afterRetry === 3, `${sync.afterRetry} operations remain`),
    );

    const source = await exerciseSourceOpen(page);
    gates.push(gate('dashboard.source.actionable', source?.startsWith('https://') === true, source ?? 'no URL opened'));

    const local = await exerciseCaptureAndComplete(page);
    gates.push(
      gate('dashboard.capture.immediate', local.captureMs <= 1_000, `${Math.round(local.captureMs)}ms`),
      gate('dashboard.complete.immediate', local.completed === true && local.completeMs <= 1_000, `${Math.round(local.completeMs)}ms`),
    );

    const moved = await exerciseCalendarMove(page);
    gates.push(gate('dashboard.calendar.keyboard-move', moved.changed, `${moved.before} -> ${moved.after}`));
    const actual = await exerciseActualTime(page, 'blk_qa', 37);
    gates.push(gate('dashboard.calendar.actual-time', actual.persisted, JSON.stringify(actual)));
    screenshots.push(await screenshot(page, destination, 'dashboard-calendar-moved.png'));

    for (const [width, height] of [[768, 900], [390, 844]]) {
      await setViewport(page, width, height);
      await navigateChrome(page, `${origin}/planner`);
      await waitForPlanner(page, 21);
      const reset = await pageProgram(page, resetPlannerScroll);
      await delay(100);
      const audit = await auditPlanner(page);
      gates.push(gate(
        `dashboard.${width}.scroll-reset-applied`,
        reset.scrollY <= 1 && reset.visualPageTop <= 1,
        JSON.stringify(reset),
      ));
      gates.push(...auditGates(`dashboard.${width}`, audit));
      screenshots.push(await screenshot(page, destination, `dashboard-dark-${width}x${height}.png`));
    }

    await setViewport(page, 1440, 900);
    await pageProgram(page, setTheme, { theme: 'light' });
    await delay(200);
    const light = await auditPlanner(page);
    gates.push(...contrastGates('dashboard.light', light));
    screenshots.push(await screenshot(page, destination, 'dashboard-light-1440x900.png'));

    await page.request('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [
        { name: 'forced-colors', value: 'active' },
        { name: 'prefers-contrast', value: 'more' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    const forced = await auditPlanner(page);
    gates.push(
      gate('dashboard.forced-colors.no-overflow', forced.documentOverflow <= 0, `${forced.documentOverflow}px`),
      gate('dashboard.reduced-motion.applied', forced.reducedMotion === true),
    );
    screenshots.push(await screenshot(page, destination, 'dashboard-forced-colors.png'));
    await page.request('Emulation.setEmulatedMedia', { media: 'screen', features: [] });

    // The first retry intentionally leaves three fixture failures visible. Let
    // the explicit "retry queued changes" action deliver them before auditing
    // a genuinely empty planner; clearing localStorage behind React would make
    // the gate lie about both retry and local-first projection.
    api.acceptFixtureOperations();
    await pageProgram(page, () => {
      const control = document.querySelector('.br-planner-sync > button');
      if (!(control instanceof HTMLButtonElement)) throw new Error('Planner sync control is missing');
      if (control.getAttribute('aria-expanded') !== 'true') control.click();
    });
    await waitForEvaluation(
      page,
      () => document.querySelector('.br-planner-retry') instanceof HTMLButtonElement,
      'Dashboard retry-all control',
    );
    await pageProgram(page, () => {
      const retry = document.querySelector('.br-planner-retry');
      if (!(retry instanceof HTMLButtonElement)) throw new Error('Retry queued changes is missing');
      retry.click();
    });
    await waitForEvaluation(
      page,
      () => /Everything is synced/i.test(document.querySelector('.br-planner-sync > button')?.textContent ?? ''),
      'Dashboard queued fixture operations to reach the server',
    );

    await page.request('Page.bringToFront');
    await waitForEvaluation(
      page,
      () => document.visibilityState === 'visible',
      'active Dashboard visibility before currentness check',
    );
    const currentnessStarted = Date.now();
    api.addRemoteItem('Remote change reached the active Dashboard');
    await waitForPageText(page, 'Remote change reached the active Dashboard', 6_500);
    const currentnessMs = Date.now() - currentnessStarted;
    gates.push(gate('dashboard.currentness.within-five-seconds', currentnessMs <= 5_500, `${currentnessMs}ms`));

    api.replacePlanner([], []);
    await waitForPageText(page, 'Nothing planned for today', 6_500);
    const empty = await pageProgram(page, inspectEmptyState);
    gates.push(gate('dashboard.empty-state.actionable', empty.capture && empty.guidance, JSON.stringify(empty)));
    screenshots.push(await screenshot(page, destination, 'dashboard-empty.png'));

    const focus = await focusAudit(page);
    gates.push(gate('dashboard.keyboard.focus-visible', focus.visible && focus.inPlanner, JSON.stringify(focus)));
    const pageErrors = await pageProgram(page, readObservedErrors);
    const unexplained = normalizeErrors([...consoleErrors, ...networkErrors, ...(pageErrors ?? [])]);
    gates.push(gate('dashboard.no-unexplained-errors', unexplained.length === 0, unexplained.join(' | ')));
  } finally {
    if (browser) await browser.stop();
    await dashboard.stop();
    await api.close();
  }
  return { browser: browser?.name ?? null, screenshots, gates, requests: api.requests };
}

async function runElectron(sharedFixture, destination) {
  const gates = [];
  const consoleErrors = [];
  const networkErrors = [];
  const screenshots = [];
  let plannerStatePath = '';
  let electron;
  try {
    electron = await launchElectron({
      desktopRoot,
      prepareLayout: async (layout) => {
        saveWorkspaceManifest(layout.workspace, createWorkspaceManifest({
          name: 'Planner visual fixture',
          profile: 'engineering',
          by: 'wizard',
          at: new Date().toISOString(),
        }));
        plannerStatePath = path.join(layout.state, 'planner-local.json');
        writePlannerFixture(plannerStatePath, corePlannerState(sharedFixture));
      },
    });
    const page = electron.renderer;
    await page.request('Page.enable');
    await page.request('Runtime.enable');
    await installObservation(page, consoleErrors, networkErrors);
    await waitForEvaluation(
      page,
      () => Boolean(document.querySelector('[data-mode="planner"]')),
      'Desktop Planner mode control',
    );
    await waitForEvaluation(
      page,
      () => {
        const dialog = document.querySelector('.onboard-dialog[role="dialog"]');
        if (!dialog) return true;
        return [...dialog.querySelectorAll('button')].some((button) => (
          button.textContent?.trim() === 'Skip setup for now' && !button.disabled
        ));
      },
      'Desktop setup dialog readiness',
    );
    await pageProgram(page, dismissDesktopSetup);
    await waitForEvaluation(
      page,
      () => !document.querySelector('[role="dialog"][aria-modal="true"]'),
      'Desktop blocking dialog to close',
    );
    gates.push(gate('electron.startup.no-blocking-dialog', true));
    await pageProgram(page, openDesktopPlanner);
    await waitForPlanner(page, 20);
    await setViewport(page, 1280, 840);

    const baseline = await auditPlanner(page);
    gates.push(...auditGates('electron.1280', baseline, { density: true, twelveVisible: true }));
    screenshots.push(await screenshot(page, destination, `electron-${process.platform}-dark-1280x840.png`));

    const sync = await exerciseSync(page, 4, async () => {
      screenshots.push(await screenshot(page, destination, `electron-${process.platform}-sync-detail.png`));
    }, { expectHostAck: true });
    gates.push(
      gate('electron.sync.inspect-four', sync.issueCount === 4, `${sync.issueCount} operations shown`),
      gate('electron.sync.actionable-detail', sync.hasAge && sync.hasAttempts && sync.hasFailure, JSON.stringify(sync)),
      gate(
        'electron.sync.targeted-retry-durable',
        sync.retryAcknowledged === true && sync.afterRetry === 4 && sync.retryButtonGone === true,
        JSON.stringify(sync),
      ),
    );

    const source = await exerciseSourceOpen(page, { expectWindowOpen: false });
    gates.push(gate(
      'electron.source.actionable',
      source?.eventOk === true
        && source?.result?.ok === true
        && source?.result?.harness === true
        && /^https:\/\//.test(source?.result?.url ?? ''),
      JSON.stringify(source ?? 'source control failed'),
    ));

    const local = await exerciseCaptureAndComplete(page);
    gates.push(
      gate('electron.capture.immediate', local.captureMs <= 1_000, `${Math.round(local.captureMs)}ms`),
      gate('electron.complete.immediate', local.completed === true && local.completeMs <= 1_000, `${Math.round(local.completeMs)}ms`),
    );

    const moved = await exerciseCalendarMove(page);
    gates.push(gate('electron.calendar.keyboard-move', moved.changed, `${moved.before} -> ${moved.after}`));
    const actual = await exerciseActualTime(page, 'blk_qa', 37, { expectHostAck: true });
    gates.push(gate('electron.calendar.actual-time', actual.persisted, JSON.stringify(actual)));
    screenshots.push(await screenshot(page, destination, `electron-${process.platform}-calendar-moved.png`));
    await selectPlannerTab(page, 'today');

    await setViewport(page, 900, 600);
    const minimum = await auditPlanner(page);
    gates.push(...auditGates('electron.900', minimum));
    screenshots.push(await screenshot(page, destination, `electron-${process.platform}-dark-900x600.png`));

    await pageProgram(page, setElectronZoom, { factor: 2 });
    await delay(250);
    await pageProgram(page, closeDesktopSidebar);
    await waitForEvaluation(
      page,
      () => document.querySelector('button[aria-label="Show sidebar"]') !== null
        && document.querySelector('.app > .rail') === null,
      'Desktop sidebar to collapse at 200% zoom',
    );
    const zoomed = await auditPlanner(page);
    gates.push(
      gate('electron.zoom-200.no-document-overflow', zoomed.documentOverflow <= 0, `${zoomed.documentOverflow}px`),
      gate('electron.zoom-200.usable-width', zoomed.viewportWidth >= 400, `${zoomed.viewportWidth}px CSS viewport`),
      gate(
        'electron.zoom-200.surface-in-viewport',
        zoomed.surfaceViewportWidth >= Math.min(160, zoomed.viewportWidth * 0.4),
        `left=${zoomed.surfaceLeft}, visible=${zoomed.surfaceViewportWidth}px of ${zoomed.viewportWidth}px`,
      ),
      ...contrastGates('electron.zoom-200', zoomed),
    );
    screenshots.push(await screenshot(page, destination, `electron-${process.platform}-zoom-200.png`));
    await pageProgram(page, setElectronZoom, { factor: 1 });

    await pageProgram(page, setTheme, { theme: 'light' });
    await delay(200);
    const light = await auditPlanner(page);
    gates.push(...contrastGates('electron.light', light));
    screenshots.push(await screenshot(page, destination, `electron-${process.platform}-light.png`));

    await page.request('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [
        { name: 'forced-colors', value: 'active' },
        { name: 'prefers-contrast', value: 'more' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    const forced = await auditPlanner(page);
    gates.push(
      gate('electron.high-contrast.no-overflow', forced.documentOverflow <= 0, `${forced.documentOverflow}px`),
      gate('electron.reduced-motion.applied', forced.reducedMotion === true),
    );
    screenshots.push(await screenshot(page, destination, `electron-${process.platform}-forced-colors.png`));
    await page.request('Emulation.setEmulatedMedia', { media: 'screen', features: [] });

    const nextState = corePlannerState(sharedFixture);
    nextState.items.remote_currentness = stampedItem('remote_currentness', 'Remote change reached the active Desktop', nextState.clock, {});
    nextState.outbox = { operations: [] };
    const currentnessStarted = Date.now();
    writePlannerFixture(plannerStatePath, nextState);
    await page.request('Page.bringToFront');
    const activeVisibility = await pageProgram(page, () => {
      window.dispatchEvent(new Event('focus'));
      return document.visibilityState;
    });
    gates.push(gate('electron.currentness.surface-active', activeVisibility === 'visible', activeVisibility));
    await waitForPageText(page, 'Remote change reached the active Desktop', 6_500);
    const currentnessMs = Date.now() - currentnessStarted;
    gates.push(gate('electron.currentness.within-five-seconds', currentnessMs <= 5_500, `${currentnessMs}ms`));

    const emptyState = corePlannerState({ ...sharedFixture, items: [], blocks: [], sync: { ...sharedFixture.sync, issues: [], pendingCount: 0 } });
    writePlannerFixture(plannerStatePath, emptyState);
    await waitForPageText(page, 'Nothing planned for today', 6_500);
    const empty = await pageProgram(page, inspectEmptyState);
    gates.push(gate('electron.empty-state.actionable', empty.capture && empty.guidance, JSON.stringify(empty)));
    screenshots.push(await screenshot(page, destination, `electron-${process.platform}-empty.png`));

    const focus = await focusAudit(page);
    gates.push(gate('electron.keyboard.focus-visible', focus.visible && focus.inPlanner, JSON.stringify(focus)));
    const pageErrors = await pageProgram(page, readObservedErrors);
    const unexplained = normalizeErrors([...consoleErrors, ...networkErrors, ...(pageErrors ?? [])]);
    gates.push(gate('electron.no-unexplained-errors', unexplained.length === 0, unexplained.join(' | ')));
  } finally {
    if (electron) await electron.stop();
  }
  return { runtime: electron?.version?.Browser ?? null, screenshots, gates };
}

async function installObservation(session, consoleErrors, networkErrors) {
  await session.request('Runtime.enable');
  await session.request('Network.enable');
  session.on('Runtime.consoleAPICalled', (event) => {
    if (event?.type !== 'error') return;
    consoleErrors.push((event.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '));
  });
  session.on('Network.loadingFailed', (event) => {
    if (event?.canceled) return;
    networkErrors.push(`${event?.errorText ?? 'network failure'} ${event?.blockedReason ?? ''}`.trim());
  });
  session.on('Network.responseReceived', (event) => {
    const status = Number(event?.response?.status ?? 0);
    if (status >= 400) networkErrors.push(`${status} ${event.response.url}`);
  });
}

const OBSERVATION_SCRIPT = `
(() => {
  globalThis.__adr038Errors = [];
  globalThis.__adr038Opened = null;
  addEventListener('error', (event) => globalThis.__adr038Errors.push(String(event.error?.message || event.message || 'window error')));
  addEventListener('unhandledrejection', (event) => globalThis.__adr038Errors.push(String(event.reason?.message || event.reason || 'unhandled rejection')));
  const originalOpen = globalThis.open;
  globalThis.open = (...args) => { globalThis.__adr038Opened = String(args[0] || ''); return null; };
  globalThis.__adr038RestoreOpen = () => { globalThis.open = originalOpen; };
})();`;

function seedDashboardBrowser({ jwt, activeOrgId, outboxKey, outbox }) {
  localStorage.setItem('brainrouter_jwt', jwt);
  localStorage.setItem('br-active-org', activeOrgId);
  localStorage.setItem(outboxKey, JSON.stringify(outbox));
  localStorage.setItem('theme', 'dark');
}

function openDesktopPlanner() {
  const button = document.querySelector('[data-mode="planner"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Planner mode control is missing');
  button.click();
}

function dismissDesktopSetup() {
  const dialog = document.querySelector('.onboard-dialog[role="dialog"]');
  if (!dialog) return false;
  const skip = [...dialog.querySelectorAll('button')].find((button) => (
    button.textContent?.trim() === 'Skip setup for now' && !button.disabled
  ));
  if (!(skip instanceof HTMLButtonElement)) throw new Error('Desktop setup dialog cannot be dismissed');
  skip.click();
  return true;
}

function setTheme({ theme }) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

function setElectronZoom({ factor }) {
  localStorage.setItem('br-zoom-factor', String(factor));
  globalThis.brainrouter?.setZoomFactor?.(factor);
  dispatchEvent(new Event('resize'));
}

function closeDesktopSidebar() {
  const button = document.querySelector('button[aria-label="Hide sidebar"]');
  if (button instanceof HTMLButtonElement) button.click();
}

function readObservedErrors() {
  return Array.isArray(globalThis.__adr038Errors) ? globalThis.__adr038Errors : [];
}

function inspectEmptyState() {
  const root = document.querySelector('.br-planner');
  return {
    capture: Boolean(root?.querySelector('input[aria-label="New planner item"]')),
    guidance: /Nothing planned for today/.test(root?.textContent ?? '')
      && /Capture an intention/.test(root?.textContent ?? ''),
  };
}

function resetPlannerScroll() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  document.documentElement.style.overflowAnchor = 'none';
  document.body.style.overflowAnchor = 'none';
  const reset = () => {
    scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    for (const element of document.querySelectorAll('*')) {
      if (!(element instanceof HTMLElement) || (element.scrollTop === 0 && element.scrollLeft === 0)) continue;
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
  };
  reset();
  return {
    scrollY,
    visualPageTop: visualViewport?.pageTop ?? scrollY,
    active: document.activeElement?.tagName ?? null,
  };
}

async function waitForPlanner(session, count) {
  try {
    await waitForEvaluation(session, (expectedCount) => {
      const root = document.querySelector('.br-planner');
      return Boolean(root) && root.querySelectorAll('.br-planner-row').length === expectedCount;
    }, `Planner with ${count} rows`, WAIT_MS, count);
  } catch (error) {
    const state = await pageProgram(session, () => ({
      href: location.href,
      rows: document.querySelectorAll('.br-planner-row').length,
      text: document.body.textContent?.replace(/\s+/g, ' ').trim().slice(0, 600),
      errors: globalThis.__adr038Errors,
    })).catch(() => null);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; page=${JSON.stringify(state)}`);
  }
}

async function waitForPageText(session, expected, timeoutMs = WAIT_MS) {
  await waitForEvaluation(session, (text) => document.body.textContent?.includes(text) === true, `text ${expected}`, timeoutMs, expected);
}

async function waitForEvaluation(session, predicate, label, timeoutMs = WAIT_MS, argument) {
  const expression = `(${predicate.toString()})(${JSON.stringify(argument)})`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await session.evaluate(expression).catch(() => false);
    if (found) return;
    await delay(75);
  }
  // A condition can become true during the last polling delay. Evaluate once
  // at the boundary before reporting a false timeout.
  if (await session.evaluate(expression).catch(() => false)) return;
  throw new Error(`Timed out waiting for ${label}`);
}

async function pageProgram(session, program, args = {}) {
  return session.evaluate(`(${program.toString()})(${JSON.stringify(args)})`);
}

async function setViewport(session, width, height) {
  await session.request('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
    screenWidth: width,
    screenHeight: height,
  });
  await delay(120);
}

async function screenshot(session, destination, name) {
  const captured = await session.request('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const target = path.join(destination, name);
  fs.writeFileSync(target, Buffer.from(captured.data, 'base64'));
  return target;
}

async function auditPlanner(session) {
  return pageProgram(session, plannerAudit);
}

function plannerAudit() {
  const root = document.querySelector('.br-planner');
  if (!(root instanceof HTMLElement)) throw new Error('Planner surface is absent');
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const rows = [...root.querySelectorAll('.br-planner-row')].filter(visible);
  const pageHeader = document.querySelector('.page-header');
  const surfaceRect = root.getBoundingClientRect();
  const surfaceViewportWidth = Math.max(0, Math.min(surfaceRect.right, innerWidth) - Math.max(surfaceRect.left, 0));
  const scroller = root.querySelector('.br-planner-scroll');
  const viewport = scroller?.getBoundingClientRect() ?? root.getBoundingClientRect();
  const active = rows.filter((row) => !row.classList.contains('is-complete'));
  const actionableVisible = active.filter((row) => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  }).length;
  const rowHeights = rows.map((row) => row.getBoundingClientRect().height);
  const controls = [...root.querySelectorAll('button,input,summary')].filter(visible);
  const undersized = controls.flatMap((control) => {
    const rect = control.getBoundingClientRect();
    return rect.width + 0.1 < 24 || rect.height + 0.1 < 24
      ? [{ name: control.getAttribute('aria-label') || control.textContent?.trim() || control.tagName, width: rect.width, height: rect.height }]
      : [];
  });
  const unnamed = controls.filter((control) => {
    const labelledBy = control.getAttribute('aria-labelledby');
    const labelled = labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : '';
    return !(control.getAttribute('aria-label') || labelled || control.textContent?.trim() || control.getAttribute('title'));
  }).map((control) => control.outerHTML.slice(0, 160));
  const rowOverlap = rows.some((row, index) => {
    const next = rows[index + 1];
    if (!next) return false;
    const a = row.getBoundingClientRect();
    const b = next.getBoundingClientRect();
    return a.bottom - b.top > 0.5 && Math.abs(a.left - b.left) < 2;
  });
  const contrast = contrastSamples(root, visible);
  return {
    rowCount: rows.length,
    actionableVisible,
    minRowHeight: rowHeights.length ? Math.min(...rowHeights) : 0,
    maxRowHeight: rowHeights.length ? Math.max(...rowHeights) : 0,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    surfaceOverflow: root.scrollWidth - root.clientWidth,
    undersized,
    unnamed,
    rowOverlap,
    contrast,
    scrollY,
    visualPageTop: visualViewport?.pageTop ?? scrollY,
    surfaceTop: surfaceRect.top,
    surfaceLeft: surfaceRect.left,
    surfaceViewportWidth,
    pageHeaderTop: pageHeader?.getBoundingClientRect().top ?? null,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    blockingDialog: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
  };

  function contrastSamples(planner, isVisible) {
    const selectors = [
      '.br-planner-title', '.br-planner-group', '.br-planner-drift',
      '.br-planner-stale', '.br-planner-source', '.br-planner-sync > button',
      '.br-planner-badge.is-blocked',
    ];
    return selectors.flatMap((selector) => {
      const element = [...planner.querySelectorAll(selector)].find(isVisible);
      if (!(element instanceof HTMLElement)) return [];
      const style = getComputedStyle(element);
      const foreground = parse(style.color);
      const background = effectiveBackground(element);
      const diagnostics = {
        theme: document.documentElement.dataset.theme,
        hover: element.matches(':hover'),
        text: style.getPropertyValue('--text').trim(),
        textFaint: style.getPropertyValue('--text-faint').trim(),
        plannerText: style.getPropertyValue('--br-ui-text').trim(),
        plannerMuted: style.getPropertyValue('--br-ui-text-muted').trim(),
      };
      if (!foreground || !background) return [{ selector, ratio: 0, color: style.color, background: 'unknown', ...diagnostics }];
      return [{ selector, ratio: ratio(composite(foreground, background), background), color: style.color, background: `rgb(${background.slice(0, 3).join(',')})`, ...diagnostics }];
    });
  }

  function effectiveBackground(element) {
    let result = [255, 255, 255, 1];
    const layers = [];
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color[3] > 0) layers.push(color);
    }
    for (const layer of layers.reverse()) result = composite(layer, result);
    return result;
  }

  function parse(value) {
    const match = /rgba?\(([^)]+)\)/.exec(value);
    if (!match) return null;
    const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }

  function composite(foreground, background) {
    const alpha = foreground[3] + background[3] * (1 - foreground[3]);
    if (alpha <= 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((index) => (
      (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha
    )).concat(alpha);
  }

  function luminance(color) {
    const channels = color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function ratio(a, b) {
    const first = luminance(a);
    const second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }
}

function auditGates(prefix, audit, requirements = {}) {
  return [
    gate(`${prefix}.twenty-items`, audit.rowCount >= 20, `${audit.rowCount} rows`),
    gate(`${prefix}.no-document-overflow`, audit.documentOverflow <= 0, `${audit.documentOverflow}px`),
    gate(`${prefix}.controls-at-least-24`, audit.undersized.length === 0, JSON.stringify(audit.undersized)),
    gate(`${prefix}.accessible-names`, audit.unnamed.length === 0, audit.unnamed.join(' | ')),
    gate(`${prefix}.no-row-overlap`, audit.rowOverlap === false),
    gate(
      `${prefix}.surface-start-visible`,
      audit.surfaceTop >= -1 && (audit.pageHeaderTop === null || audit.pageHeaderTop >= -1),
      `scroll=${audit.scrollY}, visual=${audit.visualPageTop}, header=${audit.pageHeaderTop}, surface=${audit.surfaceTop}`,
    ),
    gate(
      `${prefix}.surface-in-viewport`,
      audit.surfaceViewportWidth >= Math.min(160, audit.viewportWidth * 0.4),
      `left=${audit.surfaceLeft}, visible=${audit.surfaceViewportWidth}px of ${audit.viewportWidth}px`,
    ),
    ...(requirements.density
      ? [gate(`${prefix}.compact-density`, audit.maxRowHeight <= 40 && audit.minRowHeight >= 35, `${audit.minRowHeight}-${audit.maxRowHeight}px`)]
      : []),
    ...(requirements.twelveVisible
      ? [gate(`${prefix}.twelve-actionable-visible`, audit.actionableVisible >= 12, `${audit.actionableVisible} visible`)]
      : []),
    ...contrastGates(prefix, audit),
  ];
}

function contrastGates(prefix, audit) {
  const failures = audit.contrast.filter((sample) => sample.ratio < 4.5);
  return [
    gate(`${prefix}.text-contrast`, failures.length === 0, JSON.stringify(failures)),
    gate(`${prefix}.no-blocking-dialog`, audit.blockingDialog === false),
  ];
}

async function focusAudit(session) {
  await pageProgram(session, () => {
    const input = document.querySelector('.br-planner input[aria-label="New planner item"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('Planner capture input is missing for focus audit');
    input.focus();
  });
  await session.request('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8,
  });
  await session.request('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8,
  });
  return pageProgram(session, () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return { visible: false, reason: 'no active element' };
    const style = getComputedStyle(active);
    const visible = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1)
      || style.boxShadow !== 'none';
    return {
      visible,
      inPlanner: Boolean(active.closest('.br-planner')),
      name: active.getAttribute('aria-label') || active.textContent?.trim(),
      outline: `${style.outlineWidth} ${style.outlineStyle}`,
      boxShadow: style.boxShadow,
    };
  });
}

async function exerciseSync(session, expected, beforeRetry, { expectHostAck = false } = {}) {
  await pageProgram(session, () => {
    const button = document.querySelector('.br-planner-sync > button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Sync control is missing');
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
  });
  await waitForEvaluation(session, (count) => document.querySelectorAll('.br-planner-sync-popover li').length === count, `${expected} sync details`, WAIT_MS, expected);
  const before = await pageProgram(session, () => {
    const popover = document.querySelector('.br-planner-sync-popover');
    const text = popover?.textContent ?? '';
    const retry = popover?.querySelector('.br-planner-retry-issue');
    return {
      issueCount: popover?.querySelectorAll('li').length ?? 0,
      hasAge: /queued\s+\d+[mhd]/i.test(text),
      hasAttempts: /\d+ attempts?/i.test(text),
      hasFailure: /refused|failed|could not|check the source/i.test(text),
      hasRetry: retry instanceof HTMLButtonElement,
    };
  });
  if (beforeRetry) await beforeRetry();
  await pageProgram(session, ({ observeHost }) => {
    if (observeHost) {
      globalThis.__adr038RetryAck = null;
      globalThis.__adr038RetryOff?.();
      globalThis.__adr038RetryOff = globalThis.brainrouter?.onEvent?.((message) => {
        const wrapped = message;
        const event = wrapped?.event ?? message;
        if (event?.kind !== 'query-result'
          || typeof event.id !== 'string'
          || !event.id.endsWith('-planner-retry-operation')) return;
        globalThis.__adr038RetryAck = {
          eventOk: event.ok === true,
          result: event.result ?? null,
          error: event.error ?? null,
        };
      });
    }
    const retry = document.querySelector('.br-planner-retry-issue');
    if (!(retry instanceof HTMLButtonElement)) throw new Error('Targeted retry is missing');
    retry.click();
  }, { observeHost: expectHostAck });
  if (expectHostAck) {
    await waitForEvaluation(
      session,
      () => globalThis.__adr038RetryAck !== null,
      'Desktop host to acknowledge the targeted retry',
    );
    await delay(150);
  } else {
    await waitForEvaluation(
      session,
      (count) => document.querySelectorAll('.br-planner-sync-popover li').length === count - 1,
      'Dashboard server to accept the targeted retry',
      WAIT_MS,
      expected,
    );
  }
  const after = await pageProgram(session, () => ({
    count: document.querySelectorAll('.br-planner-sync-popover li').length,
    retryButtonGone: !document.querySelector('.br-planner-retry-issue'),
    retryAck: globalThis.__adr038RetryAck ?? null,
  }));
  await pageProgram(session, () => {
    globalThis.__adr038RetryOff?.();
    globalThis.__adr038RetryOff = null;
    const button = document.querySelector('.br-planner-sync > button');
    if (button instanceof HTMLButtonElement && button.getAttribute('aria-expanded') === 'true') button.click();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  return {
    ...before,
    afterRetry: after.count,
    retryButtonGone: after.retryButtonGone,
    retryAcknowledged: after.retryAck?.eventOk === true
      && after.retryAck?.result?.status === 'retry_requested',
    retryAck: after.retryAck,
  };
}

async function exerciseSourceOpen(session, { expectWindowOpen = true } = {}) {
  await selectPlannerTab(session, 'today');
  const clicked = await pageProgram(session, () => {
    const source = [...document.querySelectorAll('.br-planner-source')]
      .find((button) => button instanceof HTMLButtonElement && !button.disabled);
    if (!(source instanceof HTMLButtonElement)) return false;
    globalThis.__adr038Opened = null;
    globalThis.__adr038SourceAck = null;
    globalThis.__adr038SourceOff?.();
    globalThis.__adr038SourceOff = globalThis.brainrouter?.onEvent?.((message) => {
      const wrapped = message;
      const event = wrapped?.event ?? message;
      if (event?.kind !== 'query-result'
        || typeof event.id !== 'string'
        || !event.id.endsWith('-action:open-external')) return;
      globalThis.__adr038SourceAck = {
        eventOk: event.ok === true,
        result: event.result ?? null,
        error: event.error ?? null,
      };
    });
    source.click();
    return true;
  });
  if (!clicked) return null;
  if (!expectWindowOpen) {
    await waitForEvaluation(
      session,
      () => globalThis.__adr038SourceAck !== null,
      'Desktop host to acknowledge source opening',
    );
    return pageProgram(session, () => {
      const answer = globalThis.__adr038SourceAck;
      globalThis.__adr038SourceOff?.();
      globalThis.__adr038SourceOff = null;
      return answer;
    });
  }
  await delay(100);
  return pageProgram(session, () => globalThis.__adr038Opened);
}

async function exerciseCaptureAndComplete(session) {
  await selectPlannerTab(session, 'today');
  const captureStarted = Date.now();
  await pageProgram(session, () => {
    const input = document.querySelector('input[aria-label="New planner item"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('Planner capture input is missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'Visual gate capture');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await waitForPageText(session, 'Visual gate capture');
  const captureMs = Date.now() - captureStarted;
  const completionStarted = Date.now();
  const completedTitle = await pageProgram(session, () => {
    const checkbox = [...document.querySelectorAll('.br-planner-row input[type="checkbox"]')]
      .find((input) => input instanceof HTMLInputElement && !input.disabled && !input.checked);
    if (!(checkbox instanceof HTMLInputElement)) return null;
    const title = checkbox.getAttribute('aria-label')?.replace(/^Complete\s+/, '') ?? '';
    checkbox.click();
    return title || null;
  });
  let completed = false;
  if (completedTitle) {
    try {
      await waitForEvaluation(session, (title) => [...document.querySelectorAll('.br-planner-row input[type="checkbox"]')]
        .some((input) => input instanceof HTMLInputElement
          && input.checked
          && input.getAttribute('aria-label') === `Reopen ${title}`), 'Planner completion', 1_500, completedTitle);
      completed = true;
    } catch { /* the timing gate below reports the failed completion */ }
  }
  return { captureMs, completed, completeMs: Date.now() - completionStarted };
}

async function exerciseCalendarMove(session) {
  await selectPlannerTab(session, 'calendar');
  await waitForEvaluation(session, () => Boolean(document.querySelector('.br-planner-calendar-event[data-block-id="blk_qa"]')), 'movable calendar block');
  const before = await pageProgram(session, () => {
    const event = document.querySelector('.br-planner-calendar-event[data-block-id="blk_qa"]');
    if (!(event instanceof HTMLButtonElement)) throw new Error('Movable calendar block is missing');
    const label = event.getAttribute('aria-label') ?? '';
    const blockId = event.dataset.blockId ?? '';
    event.focus();
    return { label, blockId };
  });
  await session.request('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, modifiers: 1,
  });
  await session.request('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, modifiers: 1,
  });
  await waitForEvaluation(session, ({ label, blockId }) => {
    const event = document.querySelector(`.br-planner-calendar-event[data-block-id="${CSS.escape(blockId)}"]`);
    return event instanceof HTMLButtonElement && event.getAttribute('aria-label') !== label;
  }, 'calendar block to move', WAIT_MS, before);
  const after = await pageProgram(session, ({ blockId }) => document.querySelector(`.br-planner-calendar-event[data-block-id="${CSS.escape(blockId)}"]`)?.getAttribute('aria-label') ?? '', before);
  return { before: before.label, after, changed: before.label !== after };
}

async function exerciseActualTime(session, blockId, minutes, { expectHostAck = false } = {}) {
  await selectPlannerTab(session, 'calendar');
  await pageProgram(session, ({ id }) => {
    const event = document.querySelector(`.br-planner-calendar-event[data-block-id="${CSS.escape(id)}"]`);
    if (!(event instanceof HTMLButtonElement)) throw new Error('Calendar block detail action is missing');
    event.click();
  }, { id: blockId });
  await waitForEvaluation(
    session,
    () => document.querySelector('.br-planner-block-details input[type="number"]') instanceof HTMLInputElement,
    'calendar block details',
  );
  await pageProgram(session, ({ value }) => {
    const input = document.querySelector('.br-planner-block-details input[type="number"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('Actual-time input is missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { value: minutes });
  // React 18 and 19 flush controlled-input state at different boundaries.
  // Submit in a separate browser task so both hosts send the value a person
  // can see, not the previous value captured by the form closure.
  await delay(50);
  await pageProgram(session, ({ observeHost }) => {
    if (observeHost) {
      globalThis.__adr038ActualAck = null;
      globalThis.__adr038ActualOff?.();
      globalThis.__adr038ActualOff = globalThis.brainrouter?.onEvent?.((message) => {
        const event = message?.event ?? message;
        if (event?.kind !== 'query-result'
          || typeof event.id !== 'string'
          || !event.id.endsWith('-planner-record-actual')) return;
        globalThis.__adr038ActualAck = {
          eventOk: event.ok === true,
          result: event.result ?? null,
          error: event.error ?? null,
        };
      });
    }
    const save = [...document.querySelectorAll('.br-planner-block-details button')]
      .find((button) => button.textContent?.trim() === 'Save actual time');
    if (!(save instanceof HTMLButtonElement)) throw new Error('Actual-time save action is missing');
    save.click();
  }, { observeHost: expectHostAck });
  await waitForEvaluation(
    session,
    () => !document.querySelector('.br-planner-block-details'),
    'actual-time editor to close',
  );
  if (expectHostAck) {
    await waitForEvaluation(
      session,
      () => globalThis.__adr038ActualAck !== null,
      'Desktop host to acknowledge actual time',
    );
  }
  let persisted = false;
  try {
    await waitForEvaluation(session, ({ id, value }) => {
      const details = document.querySelector('.br-planner-block-details');
      if (!details) {
        const event = document.querySelector(`.br-planner-calendar-event[data-block-id="${CSS.escape(id)}"]`);
        if (event instanceof HTMLButtonElement) event.click();
        return false;
      }
      const input = details.querySelector('input[type="number"]');
      return input instanceof HTMLInputElement && Number(input.value) === value;
    }, 'actual time to persist through the host adapter', WAIT_MS, { id: blockId, value: minutes });
    persisted = true;
  } catch { /* returned diagnostics make the gate fail with the host response */ }
  const result = await pageProgram(session, () => {
    const input = document.querySelector('.br-planner-block-details input[type="number"]');
    return {
      observed: input instanceof HTMLInputElement ? Number(input.value) : null,
      ack: globalThis.__adr038ActualAck ?? null,
    };
  });
  await pageProgram(session, () => {
    globalThis.__adr038ActualOff?.();
    globalThis.__adr038ActualOff = null;
    const close = [...document.querySelectorAll('.br-planner-block-details button')]
      .find((button) => button.textContent?.trim() === 'Close');
    if (close instanceof HTMLButtonElement) close.click();
  });
  return {
    requested: minutes,
    observed: result.observed,
    persisted: persisted && result.observed === minutes,
    ...(result.ack ? { hostAck: result.ack } : {}),
  };
}

async function selectPlannerTab(session, tab) {
  await pageProgram(session, ({ tab: id }) => {
    const button = [...document.querySelectorAll(`#br-planner-tab-${CSS.escape(id)}`)]
      .find((candidate) => candidate instanceof HTMLButtonElement && candidate.getClientRects().length > 0);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Planner ${id} tab is missing`);
    button.click();
  }, { tab });
  await waitForEvaluation(session, (id) => (
    [...document.querySelectorAll(`#br-planner-tab-${CSS.escape(id)}`)]
      .some((candidate) => candidate.getClientRects().length > 0 && candidate.getAttribute('aria-selected') === 'true')
  ), `Planner ${tab} tab`, WAIT_MS, tab);
}

function dashboardOutbox(sharedFixture) {
  const stamp = (index) => ({
    physical: Date.now() - (4 - index) * 3_600_000,
    logical: 0,
    deviceId: 'dashboard-visual',
  });
  return sharedFixture.sync.issues.map((issue, index) => {
    const at = stamp(index);
    const block = issue.entity === 'block' ? sharedFixture.blocks.find((candidate) => candidate.itemId === issue.itemId) : null;
    const item = sharedFixture.items.find((candidate) => candidate.id === issue.itemId);
    return {
      idempotencyKey: issue.id,
      itemId: block?.id ?? issue.itemId,
      entity: issue.entity,
      kind: issue.action,
      at,
      payload: block
        ? { itemId: block.itemId, scheduledFor: block.scheduledFor }
        : issue.action === 'create'
          ? { title: item?.title ?? 'Queued planner item' }
          : { completed: false },
      attempts: issue.attempts,
      ...(issue.lastError ? { lastError: issue.lastError } : {}),
    };
  });
}

function corePlannerState(sharedFixture) {
  const base = Date.now() - 60_000;
  const clock = { physical: base + 10_000, logical: 0, deviceId: 'electron-visual' };
  const items = Object.fromEntries(sharedFixture.items.map((item, index) => {
    const at = { physical: base + index, logical: 0, deviceId: 'electron-visual' };
    return [item.id, stampedItem(item.id, item.title, at, item)];
  }));
  const blocks = Object.fromEntries(sharedFixture.blocks.map((block, index) => [block.id, {
    ...block,
    updatedAt: { physical: base + 100 + index, logical: 0, deviceId: 'electron-visual' },
  }]));
  const operations = dashboardOutbox(sharedFixture).map((operation) => ({
    ...operation,
    attempts: operation.attempts ?? 0,
  }));
  return {
    schemaVersion: 1,
    deviceId: 'electron-visual',
    lastPulledAt: new Date(base).toISOString(),
    clock,
    items,
    blocks,
    outbox: { operations },
  };
}

function writePlannerFixture(filePath, state) {
  const temporary = `${filePath}.visual-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function stampedItem(id, title, at, item) {
  const provenance = item.provenance ? {
    sourceId: item.provenance.kind ?? item.sourceKind ?? item.source ?? 'connected',
    sourceLabel: item.provenance.source,
    ...(item.provenance.externalId ? { externalId: item.provenance.externalId } : {}),
    ...(item.provenance.url ? { sourceUrl: item.provenance.url } : {}),
    fetchedAt: item.provenance.fetchedAt ?? new Date(at.physical).toISOString(),
  } : undefined;
  return {
    id,
    origin: item.origin ?? 'owned',
    ...(item.source ? { source: item.source } : {}),
    ...(provenance ? { provenance, fetchedAt: provenance.fetchedAt } : {}),
    title: { value: title, at },
    ...(item.notes ? { notes: { value: item.notes, at } } : {}),
    ...(item.dueDate ? { dueDate: { value: item.dueDate, at } } : {}),
    ...(item.priority !== undefined ? { priority: { value: item.priority, at } } : {}),
    ...(item.completed ? { completed: { value: true, at } } : {}),
    ...(item.estimateMinutes !== undefined ? { estimateMinutes: item.estimateMinutes, estimateUpdatedAt: at } : {}),
    ...(item.blockedReason ? { blockedReason: { value: item.blockedReason, at } } : {}),
  };
}

function createPlannerApi(sharedFixture) {
  let items = sharedFixture.items.map((item, index) => dashboardItem(item, index));
  let blocks = sharedFixture.blocks.map((block) => ({ ...block }));
  let pushCount = 0;
  let rejectFixtureOperations = true;
  const requests = [];
  let detach = null;
  let attachedSession = null;
  return {
    get pushCount() { return pushCount; },
    requests,
    async attach(session) {
      attachedSession = session;
      await session.request('Fetch.enable', {
        patterns: [{ urlPattern: `http://localhost:${API_PORT}/api/*`, requestStage: 'Request' }],
      });
      detach = session.on('Fetch.requestPaused', (event) => { void handlePaused(session, event); });
    },
    addRemoteItem(title) {
      const at = { physical: Date.now(), logical: 0, deviceId: 'remote-visual' };
      items = [{ id: `remote_${at.physical}`, origin: 'owned', title: { value: title, at } }, ...items];
    },
    replacePlanner(nextItems, nextBlocks) {
      items = nextItems.map((item, index) => dashboardItem(item, index));
      blocks = nextBlocks.map((block) => ({ ...block }));
    },
    acceptFixtureOperations() {
      rejectFixtureOperations = false;
    },
    async close() {
      detach?.();
      detach = null;
      if (attachedSession) await attachedSession.request('Fetch.disable').catch(() => {});
      attachedSession = null;
    },
  };

  async function handlePaused(session, event) {
    const url = new URL(event.request.url);
    const method = event.request.method;
    const headers = [
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type, X-BrainRouter-Org' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
      { name: 'Content-Type', value: 'application/json' },
    ];
    const answer = (status, body) => session.request('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: status,
      responseHeaders: headers,
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
    });
    try {
      if (method === 'OPTIONS') { await answer(204, {}); return; }
      requests.push(`${method} ${url.pathname}`);
      if (url.pathname === '/api/auth/me') { await answer(200, {
      userId: 'visual-person', displayName: 'Visual Reviewer', email: 'visual@example.test', isAdmin: true,
      }); return; }
      if (url.pathname === '/api/orgs' && method === 'GET') { await answer(200, {
      orgs: [{ orgId: 'org-visual', name: 'Visual workspace', slug: 'visual', plan: 'pro', role: 'owner', capabilities: [], isDefault: true, isPersonal: true }],
      }); return; }
      if (url.pathname === '/api/orgs/org-visual/default') { await answer(200, { ok: true }); return; }
      if (url.pathname === '/api/planner/pull') { await answer(200, {
      items,
      blocks,
      cursor: String(Date.now()),
      serverClock: { physical: Date.now(), logical: 0, deviceId: 'server-visual' },
      }); return; }
      if (url.pathname === '/api/planner/push' && method === 'POST') {
        pushCount += 1;
        const body = event.request.postData ? JSON.parse(event.request.postData) : {};
        const operations = Array.isArray(body?.operations) ? body.operations : [];
        const accepted = [];
        const rejected = [];
        for (const operation of operations) {
          if (rejectFixtureOperations
            && String(operation.idempotencyKey).startsWith('fixture-op-')
            && operation.idempotencyKey !== 'fixture-op-1') {
            rejected.push({ idempotencyKey: operation.idempotencyKey, reason: 'The fixture keeps this queued for inspection.' });
            continue;
          }
          applyDashboardOperation(operation);
          accepted.push(operation.idempotencyKey);
        }
        await answer(200, { accepted, rejected });
        return;
      }
      await answer(404, { error: 'Fixture endpoint not found' });
    } catch (error) {
      await answer(500, { error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
  }

  function applyDashboardOperation(operation) {
    const entity = operation.entity ?? 'item';
    if (entity === 'block') {
      const index = blocks.findIndex((block) => block.id === operation.itemId);
      if (operation.kind === 'create' && index < 0) blocks.push({ id: operation.itemId, ...operation.payload });
      else if (index >= 0) blocks[index] = { ...blocks[index], ...operation.payload };
      return;
    }
    const index = items.findIndex((item) => item.id === operation.itemId);
    if (operation.kind === 'delete') { if (index >= 0) items.splice(index, 1); return; }
    if (operation.kind === 'create' && index < 0) {
      const wireTitle = operation.payload?.title;
      const title = wireTitle && typeof wireTitle === 'object' && 'value' in wireTitle
        ? wireTitle.value
        : wireTitle;
      items.unshift({ id: operation.itemId, origin: 'owned', title: { value: title ?? 'Untitled', at: operation.at } });
      return;
    }
    if (index < 0) return;
    const current = items[index];
    const patch = operation.payload ?? {};
    items[index] = {
      ...current,
      ...(patch.title !== undefined ? { title: { value: typeof patch.title === 'object' ? patch.title.value : patch.title, at: operation.at } } : {}),
      ...(patch.completed !== undefined ? { completed: { value: typeof patch.completed === 'object' ? patch.completed.value : patch.completed, at: operation.at } } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: { value: typeof patch.dueDate === 'object' ? patch.dueDate.value : patch.dueDate, at: operation.at } } : {}),
    };
  }
}

function dashboardItem(item, index) {
  const at = { physical: Date.now() - 10_000 + index, logical: 0, deviceId: 'server-visual' };
  const provenance = item.provenance ? {
    sourceId: item.provenance.kind ?? item.sourceKind ?? item.source ?? 'connected',
    sourceLabel: item.provenance.source,
    ...(item.provenance.externalId ? { externalId: item.provenance.externalId } : {}),
    ...(item.provenance.url ? { sourceUrl: item.provenance.url } : {}),
    fetchedAt: item.provenance.fetchedAt ?? new Date(at.physical).toISOString(),
  } : undefined;
  return {
    id: item.id,
    origin: item.origin,
    ...(item.source ? { source: item.source } : {}),
    ...(provenance ? { provenance, fetchedAt: provenance.fetchedAt } : {}),
    title: { value: item.title, at },
    ...(item.notes ? { notes: { value: item.notes, at } } : {}),
    ...(item.dueDate ? { dueDate: { value: item.dueDate, at } } : {}),
    ...(item.priority !== undefined ? { priority: { value: item.priority, at } } : {}),
    ...(item.completed ? { completed: { value: true, at } } : {}),
    ...(item.estimateMinutes !== undefined ? { estimateMinutes: item.estimateMinutes } : {}),
    ...(item.blockedReason ? { blockedReason: { value: item.blockedReason, at } } : {}),
  };
}

function visualJwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'visual-person', exp: Math.floor(Date.now() / 1000) + 3600 })}.visual`;
}

function startProcess(executable, args, { cwd, label }) {
  let output = '';
  // npm launches the host as a child process. Give that tree its own POSIX
  // process group so stopping the gate cannot leave Next.js holding the output
  // pipes open after npm exits. Windows does not support negative-PID signals.
  const detached = process.platform !== 'win32';
  const child = spawn(executable, args, {
    cwd,
    env: process.env,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => { output = `${output}${String(chunk)}`.slice(-16_000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  return {
    async stop() {
      if (child.exitCode !== null) return;
      const ended = new Promise((resolve) => child.once('exit', resolve));
      killProcessTree(child, 'SIGTERM', detached);
      if (await Promise.race([ended.then(() => true), delay(3_000).then(() => false)])) return;
      killProcessTree(child, 'SIGKILL', detached);
      await Promise.race([ended, delay(1_000)]);
    },
    assert() {
      if (child.exitCode !== null) throw new Error(`${label} exited with ${child.exitCode}\n${output}`);
    },
  };
}

function killProcessTree(child, signal, detached) {
  try {
    if (detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already stopped */ }
}

async function waitForHttp(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* still starting */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitFor(predicate, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a Dashboard port');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function normalizeErrors(errors) {
  return [...new Set(errors.map((error) => String(error).trim()).filter(Boolean))]
    .filter((error) => !/favicon\.ico|ERR_ABORTED|ResizeObserver loop/i.test(error));
}

await main();
