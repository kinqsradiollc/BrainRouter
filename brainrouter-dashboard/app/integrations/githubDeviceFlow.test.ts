import assert from "node:assert/strict";
import test from "node:test";
import { applyGithubDevicePoll, beginGithubDeviceFlow, shouldUseGithubDeviceFallback } from "./githubDeviceFlow";

test("GitHub device fallback is limited to an unavailable web OAuth app", () => {
  assert.equal(shouldUseGithubDeviceFallback(Object.assign(new Error("not configured"), { status: 409 })), true);
  assert.equal(shouldUseGithubDeviceFallback(Object.assign(new Error("forbidden"), { status: 403 })), false);
  assert.equal(shouldUseGithubDeviceFallback(new Error("network")), false);
});

test("device start validates GitHub and bounds provider timing", () => {
  assert.deepEqual(beginGithubDeviceFlow({
    userCode: " BR-1234 ",
    verificationUri: "https://github.com/login/device",
    interval: 0,
    expiresIn: 10_000,
  }, 1_000), {
    status: "pending",
    userCode: "BR-1234",
    verificationUri: "https://github.com/login/device",
    intervalMs: 1_000,
    expiresAtMs: 1_801_000,
  });
  assert.deepEqual(beginGithubDeviceFlow({
    userCode: "BR-1234",
    verificationUri: "https://attacker.test/device",
    interval: 5,
    expiresIn: 900,
  }), { status: "error", error: "GitHub returned an invalid device authorization response." });
});

test("device polling stays pending, connects, and fails closed on expiry or denial", () => {
  const pending = beginGithubDeviceFlow({
    userCode: "BR-1234",
    verificationUri: "https://github.com/login/device",
    interval: 5,
    expiresIn: 900,
  }, 10_000);
  assert.equal(pending.status, "pending");
  if (pending.status !== "pending") return;

  assert.equal(applyGithubDevicePoll(pending, { status: "pending" }, 11_000), pending);
  assert.deepEqual(applyGithubDevicePoll(pending, { status: "connected", login: " octocat " }, 12_000), { status: "connected", login: "octocat" });
  assert.deepEqual(applyGithubDevicePoll(pending, { status: "error", error: "access denied" }, 13_000), { status: "error", error: "access denied" });
  assert.deepEqual(applyGithubDevicePoll(pending, { status: "pending" }, pending.expiresAtMs), {
    status: "error",
    error: "GitHub authorization expired. Click Connect to try again.",
  });
});
