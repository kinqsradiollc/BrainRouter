// ADR-041 D4b — agent phase hooks: registration store + selector.
import test from "node:test";
import assert from "node:assert/strict";
import {
  registerExtensionPhaseHook,
  phaseHookHandlers,
  resetExtensionContributions,
  type PhaseHookHandler,
} from "../extension/registry.js";

test("registerPhaseHook stores a handler retrievable only by its phase", () => {
  resetExtensionContributions();
  try {
    let fired = false;
    const handler: PhaseHookHandler = {
      after: () => {
        fired = true;
      },
    };
    registerExtensionPhaseHook("turn-end", handler, "test-ext");

    // Selected by matching phase, isolated from other phases.
    assert.equal(phaseHookHandlers("turn-end").length, 1);
    assert.equal(phaseHookHandlers("provider-call").length, 0);
    assert.equal(phaseHookHandlers("turn-start").length, 0);

    // The stored handler is the registered one and fires.
    phaseHookHandlers("turn-end")[0].after?.(
      { phase: "turn-end", workspaceRoot: "/w", sessionKey: "s" },
      () => {},
    );
    assert.equal(fired, true);
  } finally {
    resetExtensionContributions();
  }
});

test("phase hooks reset with the contribution store", () => {
  resetExtensionContributions();
  registerExtensionPhaseHook("turn-end", { after: () => {} }, "test-ext");
  assert.equal(phaseHookHandlers("turn-end").length, 1);
  resetExtensionContributions();
  assert.equal(phaseHookHandlers("turn-end").length, 0);
});
