import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_NAV_GROUPS, isNavItemActive } from "./dashboardNavigation";

test("review automation is one focused Workspace settings route", () => {
  const workspace = SETTINGS_NAV_GROUPS.find((group) => group.label === "Workspace");
  const item = workspace?.items.find((candidate) => candidate.href === "/review-automation");
  assert.equal(item?.label, "Review automation");
  assert.equal(item?.adminOnly, undefined);
  assert.equal(isNavItemActive("/review-automation", item!), true);
});
