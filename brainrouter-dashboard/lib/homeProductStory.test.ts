import assert from "node:assert/strict";
import test from "node:test";
import { OVERVIEW_ACTIONS, PRODUCT_CAPABILITIES, PRODUCT_LOOP, PRODUCT_SURFACES } from "./homeProductStory";

test("the home story follows BrainRouter's product-wide operating loop", () => {
  assert.deepEqual(PRODUCT_LOOP.map((step) => step.label), ["Plan", "Build", "Connect", "Track", "Know", "Verify"]);
});

test("the public story represents every current product surface and core capability", () => {
  assert.deepEqual(PRODUCT_SURFACES.map((surface) => surface.title), ["Desktop", "CLI", "Dashboard", "MCP + API"]);
  const story = PRODUCT_CAPABILITIES.map((capability) => `${capability.title} ${capability.copy} ${capability.label}`).join(" ");
  for (const currentCapability of ["agent workbench", "models", "repositories", "meetings", "teams", "memory", "CVE"]) {
    assert.match(story, new RegExp(currentCapability, "i"));
  }
});

test("Overview leads into operational work instead of analytics-only destinations", () => {
  assert.deepEqual(OVERVIEW_ACTIONS.map((action) => action.href), [
    "/chat",
    "/track",
    "/meetings",
    "/integrations",
    "/knowledge",
    "/reviews",
  ]);
});
