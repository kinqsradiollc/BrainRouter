import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayAuthError, MODEL_INVOKE_SCOPE } from "./auth.js";
import { createGatewayApp, type GatewayHttpService } from "./server.js";

function unusedDataPlane(): Pick<
  GatewayHttpService,
  "listModels" | "resolveModel" | "acquireRequest" | "releaseRequest" | "recordUsage"
> {
  return {
    listModels: vi.fn(async () => []),
    resolveModel: vi.fn(async () => { throw new Error("not used"); }),
    acquireRequest: vi.fn(async () => undefined),
    releaseRequest: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  };
}

describe("hosted model gateway HTTP boundary", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function request(
    svc: GatewayHttpService,
    path: string,
    init: RequestInit = {},
  ): Promise<{ response: Response; body: any }> {
    const server = createGatewayApp(svc).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const body = await response.json();
    return { response, body };
  }

  it("derives tenant context from the bearer and validated org header, never a body orgId", async () => {
    const authenticate = vi.fn(async () => ({
      credentialType: "jwt" as const,
      principalType: "user" as const,
      userId: "user-1",
      orgId: "org-allowed",
      role: "developer" as const,
      scopes: [MODEL_INVOKE_SCOPE],
    }));
    const svc: GatewayHttpService = {
      ping: vi.fn(async () => true),
      authenticate,
      ...unusedDataPlane(),
    };

    const { response } = await request(svc, "/v1/not-yet-implemented", {
      method: "POST",
      headers: {
        Authorization: "Bearer signed-access-token",
        "Content-Type": "application/json",
        "X-BrainRouter-Org": "org-allowed",
      },
      body: JSON.stringify({ orgId: "org-attacker" }),
    });

    expect(response.status).toBe(404);
    expect(authenticate).toHaveBeenCalledWith("signed-access-token", "org-allowed");
  });

  it("removes the credential-returning resolve route", async () => {
    const svc: GatewayHttpService = {
      ping: vi.fn(async () => true),
      authenticate: vi.fn(async () => ({
        credentialType: "api_key" as const,
        principalType: "user" as const,
        userId: "user-1",
        orgId: "org-1",
        role: "owner" as const,
        scopes: [MODEL_INVOKE_SCOPE],
      })),
      ...unusedDataPlane(),
    };
    const { response, body } = await request(svc, "/v1/resolve", {
      method: "POST",
      headers: { Authorization: "Bearer br_active", "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: "org-1", kind: "llm" }),
    });

    expect(response.status).toBe(404);
    expect(JSON.stringify(body)).not.toMatch(/provider|api.?key|credential/i);
  });

  it("returns canonical auth errors without reflecting a credential", async () => {
    const svc: GatewayHttpService = {
      ping: vi.fn(async () => true),
      authenticate: vi.fn(async () => {
        throw new GatewayAuthError(403, "account_disabled", "The account is disabled.");
      }),
      ...unusedDataPlane(),
    };
    const { response, body } = await request(svc, "/v1/models", {
      headers: { Authorization: "Bearer do-not-reflect" },
    });

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: {
        message: "The account is disabled.",
        type: "authentication_error",
        param: null,
        code: "account_disabled",
      },
    });
    expect(JSON.stringify(body)).not.toContain("do-not-reflect");
  });
});
