import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const overview = readFileSync(new URL("../app/overview/page.tsx", import.meta.url), "utf8");
const overviewStyles = readFileSync(new URL("../app/overview/overview.module.css", import.meta.url), "utf8");
const orbit = readFileSync(new URL("../components/ProductOrbit.tsx", import.meta.url), "utf8");
const orbitStyles = readFileSync(new URL("../components/productOrbit.module.css", import.meta.url), "utf8");
const dashboardPackage = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("shared dashboard and public shells cannot create page-level horizontal overflow", () => {
  assert.match(globals, /html, body \{[\s\S]*?overflow-x: clip;/);
  assert.match(globals, /\.dashboard-shell \{[\s\S]*?max-width: 100vw;[\s\S]*?min-width: 0;/);
  assert.match(globals, /\.content-scroll > \* \{\s*min-width: 0;/);
  assert.match(globals, /\.public-content > \* \{\s*min-width: 0;/);
  assert.match(globals, /\.platform-landing \{[^}]*min-width: 0;[^}]*overflow: clip;/);
  assert.match(globals, /@media \(max-width: 640px\)[\s\S]*?\.platform-hero h1 \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-wrap: break-word;/);
});

test("the product scene uses a real, responsive Three.js runtime with a static reduced-motion mode", () => {
  assert.match(dashboardPackage, /"three"/);
  assert.match(orbit, /import\("three"\)/);
  assert.match(orbit, /ResizeObserver/);
  assert.match(orbit, /prefers-reduced-motion: reduce/);
  assert.match(orbitStyles, /container-type: inline-size;/);
  assert.match(orbitStyles, /@container \(max-width: 520px\)/);
  assert.match(orbitStyles, /@container \(max-width: 360px\)/);
  assert.match(orbitStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important;/);
});

test("Overview leads with work and keeps charts in a supporting telemetry section", () => {
  const hero = overview.indexOf("styles.homeHero");
  const actions = overview.indexOf("OVERVIEW_ACTIONS.map");
  const telemetry = overview.indexOf('id="telemetry-heading"');
  const stats = overview.indexOf("styles.stats");

  assert.ok(hero >= 0 && actions > hero, "operational actions should follow the home hero");
  assert.ok(telemetry > actions && stats > telemetry, "telemetry should follow operational destinations");
  assert.match(overviewStyles, /@media \(max-width: 640px\)[\s\S]*?\.actionGrid \{\s*grid-template-columns: 1fr;/);
});

test("Overview activity combines PR reviews, tests, and other verification work", () => {
  assert.match(overview, /Workspace activity/);
  assert.match(overview, /PR reviews/);
  assert.match(overview, /Security tests/);
  assert.match(overview, /Findings resolved/);
  assert.doesNotMatch(overview, /aria-label="Pentest activity over the last year"/);
});

test("Overview renders durable remediation and contributor statistics", () => {
  assert.match(overview, /summary\.contributors/);
  assert.match(overview, /findingsFixed/);
  assert.match(overview, /openFindings/);
  assert.match(overview, /lastActivityAt/);
  assert.match(overview, /meanTimeToRemediateDays/);
  assert.doesNotMatch(overview, /<strong>No contributor data<\/strong>/);
});
