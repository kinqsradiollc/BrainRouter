import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDelegationPayload,
  renderDelegationPrompt,
  adaptDelegationFor,
} from "../orchestration/delegation.js";
import { applyFederationIdentity } from "../runtime/federationIdentity.js";
import type { DelegationPacket } from "@kinqs/brainrouter-types";

const PACKET: DelegationPacket = {
  goal: "Refactor the auth module",
  fromSessionKey: "sender",
  originatingClient: "brainrouter-cli",
  originatingWorkspace: "/ws/app",
  files: ["src/auth.ts"],
  constraints: ["keep the public API stable"],
  modelHints: ["prefer:reasoning"],
  budget: { tokens: 5000 },
  deadline: "2026-06-01T00:00:00.000Z",
  note: "high priority",
  createdAt: "2026-05-29T00:00:00.000Z",
};

test("FED-S5 buildDelegationPayload normalizes + defaults", () => {
  const p = buildDelegationPayload({ goal: "  x  ", originatingClient: "brainrouter-cli", originatingWorkspace: "/ws" });
  assert.equal(p.goal, "x");
  assert.deepEqual(p.files, []);
  assert.deepEqual(p.constraints, []);
  assert.equal(p.budget, null);
  assert.equal((p as any).note, undefined);
});

test("FED-S5 renderDelegationPrompt embeds goal, files, constraints, hints, budget", () => {
  const out = renderDelegationPrompt(PACKET);
  assert.match(out, /Refactor the auth module/);
  assert.match(out, /src\/auth\.ts/);
  assert.match(out, /keep the public API stable/);
  assert.match(out, /prefer:reasoning/);
  assert.match(out, /5000 tokens/);
  assert.match(out, /Delegated from brainrouter-cli/);
});

test("FED-S5 adapter: brainrouter-cli is goal-native", () => {
  const a = adaptDelegationFor("brainrouter-cli", PACKET);
  assert.equal(a.mode, "goal");
  if (a.mode === "goal") {
    assert.equal(a.goal, "Refactor the auth module");
    assert.match(a.note ?? "", /## Constraints/);
  }
});

test("FED-S5 adapter: claude-code + codex are prompt-driven; unknown falls back to prompt", () => {
  for (const kind of ["claude-code", "codex", "some-future-cli"]) {
    const a = adaptDelegationFor(kind, PACKET);
    assert.equal(a.mode, "prompt", `${kind} should be prompt mode`);
    if (a.mode === "prompt") assert.match(a.prompt, /Delegated task/);
  }
});

test("FED-S5 federation identity forces from on delegate_task, sessionKey on claim", () => {
  const fed = "fed-key-123";
  const del = applyFederationIdentity("session_delegate_task", { agentKind: "codex", payload: {}, from: "wrong" }, fed) as any;
  assert.equal(del.from, fed);

  const claim = applyFederationIdentity("session_delegations", { action: "claim", agentKind: "codex" }, fed) as any;
  assert.equal(claim.sessionKey, fed);

  // namespaced MCP name still matches
  const ns = applyFederationIdentity("mcp_brainrouter_session_delegate_task", { from: "x" }, fed) as any;
  assert.equal(ns.from, fed);

  // no federation key → untouched
  const passthrough = applyFederationIdentity("session_delegate_task", { from: "x" }, null) as any;
  assert.equal(passthrough.from, "x");
});
