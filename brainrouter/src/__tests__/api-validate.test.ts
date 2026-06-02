import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { validate, type ValidatedRequest } from "../api/middleware/validate.js";

describe("API-VALIDATE — validate() middleware", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function start(): Promise<string> {
    const app = express();
    app.use(express.json());
    app.post(
      "/c/:id/resolve",
      validate({
        params: z.object({ id: z.string().min(1) }),
        body: z.object({ status: z.enum(["resolved", "dismissed"]).optional() }),
      }),
      (req: ValidatedRequest, res) => {
        res.json({ ok: true, valid: req.valid });
      },
    );
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("passes valid input and attaches req.valid", async () => {
    const base = await start();
    const res = await post(base, "/c/abc/resolve", { status: "dismissed" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.valid.body).toEqual({ status: "dismissed" });
    expect(body.valid.params).toEqual({ id: "abc" });
  });

  it("allows an omitted optional field", async () => {
    const base = await start();
    const res = await post(base, "/c/abc/resolve", {});
    expect(res.status).toBe(200);
  });

  it("rejects an invalid enum with 400 + structured details", async () => {
    const base = await start();
    const res = await post(base, "/c/abc/resolve", { status: "garbage" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0].path).toContain("status");
  });

  it("rejects a wrong-type field", async () => {
    const base = await start();
    const res = await post(base, "/c/abc/resolve", { status: 123 });
    expect(res.status).toBe(400);
  });
});
