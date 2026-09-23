// ADR-041 A41-12 — the committed deploy compose must boot the gateway through the
// loader with the profile's id and port. The service PROFILE is the authoritative
// boot source; this guards the one invariant a drift would break (a wrong id or
// port bricks the container): the compose `command` is the loader form for the
// profile id, and the profile's default port is the one the compose publishes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVICE_PROFILES } from "@kinqs/brainrouter-core/runtime";

const COMPOSE_PATH = fileURLToPath(
  new URL("../../../deploy/stack/docker-compose.yml", import.meta.url),
);

/** Extract the indented block of a top-level compose service by name. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`service ${name} not found in compose`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() && !line.startsWith("    ") && !line.startsWith("  #")) break;
    body.push(line);
  }
  return body.join("\n");
}

describe("ADR-041 A41-12 — gateway boots via the loader from its profile", () => {
  const compose = readFileSync(COMPOSE_PATH, "utf8");
  const gateway = serviceBlock(compose, "gateway");
  const profile = SERVICE_PROFILES["provider-gateway"];

  it("the compose command is the loader form for the provider-gateway profile id", () => {
    const expected = `command: ["node", "dist/services/loader.js", "${profile.id}"]`;
    expect(gateway).toContain(expected);
    // And no longer the old bespoke per-service entrypoint.
    expect(gateway).not.toContain('dist/services/gateway/index.js');
  });

  it("the compose publishes and health-checks the profile's default port", () => {
    expect(profile.defaultPort).toBe(3748);
    expect(gateway).toContain(`GATEWAY_PORT: "${profile.defaultPort}"`);
    expect(gateway).toContain(`:${profile.defaultPort}"`); // published port mapping
    expect(gateway).toContain(`http://127.0.0.1:${profile.defaultPort}/health`);
  });
});
