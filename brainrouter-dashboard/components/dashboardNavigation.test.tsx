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
  const know = PRODUCT_NAV_GROUPS.find((group) => group.label === "Know");
  const item = know?.items.find((candidate) => candidate.href === "/integrations");
  assert.equal(item?.label, "Connections");
  assert.equal(item?.adminOnly, undefined);
});

test("learned behavior is grouped under the Knowledge route", () => {
  const know = PRODUCT_NAV_GROUPS.find((group) => group.label === "Know");
  const item = know?.items.find((candidate) => candidate.href === "/knowledge");
  assert.equal(isNavItemActive("/learned-behaviors", item!), true);
});

// The repositioning rule, as a test: this is a workspace a whole team works in,
// so the surfaces a non-engineer came for must sit in the first nav group,
// above anything about code. Regressing this is how the product starts reading
// as an engineering tool again.
test("the first nav group leads with the team surfaces, not the engineering ones", () => {
  const first = PRODUCT_NAV_GROUPS[0];
  const hrefs = first.items.map((item) => item.href);
  for (const href of ["/planner", "/meetings", "/notes", "/track", "/teams"]) {
    assert.ok(hrefs.includes(href), `${href} belongs in the first nav group, found: ${hrefs.join(", ")}`);
  }
  const engineering = PRODUCT_NAV_GROUPS.slice(1).flatMap((group) => group.items.map((item) => item.href));
  for (const href of ["/repositories", "/reviews", "/vulnerabilities"]) {
    assert.ok(engineering.includes(href), `${href} should not be in the first nav group`);
  }
});
