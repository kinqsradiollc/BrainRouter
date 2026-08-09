import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { matchesMcpSessionIdentity, type McpSessionIdentity } from "./mcpSessionIdentity.js";

const identity: McpSessionIdentity = {
  userId: "developer-1",
  orgId: "org-a",
  role: "developer",
  isAdmin: false,
};

describe("HTTP MCP session identity", () => {
  it("accepts the exact actor and tenant context", () => {
    expect(matchesMcpSessionIdentity(identity, { ...identity })).toBe(true);
  });

  it.each([
    { ...identity, userId: "developer-2" },
    { ...identity, orgId: "org-b" },
    { ...identity, role: "viewer" as const },
    { ...identity, isAdmin: true },
  ])("requires reconnect when authentication context changes", (current) => {
    expect(matchesMcpSessionIdentity(identity, current)).toBe(false);
  });

  it("revalidates disabled status and organization membership before dispatching an existing session", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function handleMcp");
    const end = source.indexOf("// DoS backstop on the MCP tool transport", start);
    const handler = source.slice(start, end);
    const credentialAt = handler.indexOf("getUserByApiKey(bearerKey)");
    const disabledAt = handler.indexOf('user.status === "disabled"');
    const membershipAt = handler.indexOf("resolveOrgContext(");
    const existingSessionAt = handler.indexOf("// Existing session");
    const pinnedIdentityAt = handler.indexOf("matchesMcpSessionIdentity(");
    const dispatchAt = handler.lastIndexOf("session.transport.handleRequest");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(credentialAt).toBeGreaterThanOrEqual(0);
    expect(disabledAt).toBeGreaterThan(credentialAt);
    expect(membershipAt).toBeGreaterThan(disabledAt);
    expect(existingSessionAt).toBeGreaterThan(membershipAt);
    expect(pinnedIdentityAt).toBeGreaterThan(existingSessionAt);
    expect(dispatchAt).toBeGreaterThan(pinnedIdentityAt);
  });
});
