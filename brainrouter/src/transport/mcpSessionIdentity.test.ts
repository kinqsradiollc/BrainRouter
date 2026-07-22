import { describe, expect, it } from "vitest";
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
});
