import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCT_NAV_GROUPS, SETTINGS_NAV_GROUPS, isNavItemActive } from "./dashboardNavigation";

test("review automation is one focused Workspace settings route", () => {
  const workspace = SETTINGS_NAV_GROUPS.find((group) => group.label === "Workspace");
  const item = workspace?.items.find((candidate) => candidate.href === "/review-automation");
  assert.equal(item?.label, "Review automation");
  assert.equal(item?.adminOnly, undefined);
  assert.equal(isNavItemActive("/review-automation", item!), true);
});

test("connections is available to normal signed-in users", () => {
  const workspace = PRODUCT_NAV_GROUPS.find((group) => group.label === "Workspace");
  const item = workspace?.items.find((candidate) => candidate.href === "/integrations");
  assert.equal(item?.label, "Connections");
  assert.equal(item?.adminOnly, undefined);
});

test("learned behavior is grouped under the Knowledge route", () => {
  const workspace = PRODUCT_NAV_GROUPS.find((group) => group.label === "Workspace");
  const item = workspace?.items.find((candidate) => candidate.href === "/knowledge");
  assert.equal(isNavItemActive("/learned-behaviors", item!), true);
});
