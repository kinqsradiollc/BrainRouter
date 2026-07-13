/**
 * atlasUiModel — turns a generated UiMap into the Atlas "Screens" view model.
 * Pure transform; tested under tsx/node --test (no React, no DOM).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { atlasUiModel, atlasElementColor } from "./atlasView.js";

const uiMap = {
  version: 1 as const,
  generatedAt: "2020-01-01T00:00:00.000Z",
  screens: [
    {
      id: "login",
      title: "Login",
      platform: "web" as const,
      route: "/login",
      filePath: "src/pages/Login.tsx",
      elements: [
        { id: "email-field", testID: "email-field", type: "input" as const, action: "type" as const, filePath: "src/pages/Login.tsx", line: 3 },
        { id: "login-submit", testID: "login-submit", type: "button" as const, action: "tap" as const },
      ],
    },
    { id: "home", title: "Home", platform: "web" as const, route: "/", elements: [] },
  ],
};

test("atlasUiModel builds one group per screen with namespaced element leaf nodes", () => {
  const m = atlasUiModel(uiMap);
  assert.equal(m.screenCount, 2);
  assert.equal(m.elementCount, 2);
  assert.equal(m.groups.length, 2);

  const login = m.groups.find((g) => g.id === "uiscreen:login");
  assert.ok(login, "login screen group exists");
  assert.deepEqual(login!.nodeIds, ["uiel:login::email-field", "uiel:login::login-submit"]);

  const el = m.elements.get("uiel:login::email-field");
  assert.equal(el?.action, "type");
  assert.equal(el?.testID, "email-field");
  assert.equal(el?.filePath, "src/pages/Login.tsx");
  assert.equal(el?.line, 3);
  assert.equal(el?.screenNodeId, "uiscreen:login");

  const screen = m.screens.get("uiscreen:login");
  assert.equal(screen?.route, "/login");
  assert.equal(screen?.filePath, "src/pages/Login.tsx");
  assert.equal(screen?.elementCount, 2);
});

test("atlasUiModel tolerates a null map and empty screens", () => {
  const empty = atlasUiModel(null);
  assert.equal(empty.screenCount, 0);
  assert.equal(empty.elementCount, 0);
  assert.equal(empty.groups.length, 0);
  assert.equal(empty.degraded, false);

  const m = atlasUiModel(uiMap);
  const home = m.groups.find((g) => g.id === "uiscreen:home");
  assert.deepEqual(home!.nodeIds, []);
  assert.equal(m.screens.get("uiscreen:home")?.elementCount, 0);
});

test("atlasUiModel surfaces the degraded flag", () => {
  const m = atlasUiModel({ ...uiMap, degraded: true });
  assert.equal(m.degraded, true);
});

test("atlasElementColor maps known actions and falls back for unknown", () => {
  assert.ok(atlasElementColor("tap").length > 0);
  assert.ok(atlasElementColor("type").length > 0);
  assert.ok(atlasElementColor("nonsense").includes("var("));
});
