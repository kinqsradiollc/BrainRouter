/**
 * ADR-035 D10 session-boundary guards: attach authentication and immutable
 * ownership, authoritative resume state, and structured adapter bootstrap.
 */
import { describe, expect, it, vi } from "vitest";

import { MODEL_INVOKE_SCOPE } from "./auth.js";
import {
  GATEWAY_AUDIO_STREAM_CLOSE,
  GATEWAY_AUDIO_STREAM_PATH,
  GatewayAudioStreamConflictError,
} from "./audio-streaming-protocol.js";
import {
  attachFrame,
  audioFrame,
  closed,
  connect,
  FULL_CAPABILITIES,
  initializationFrame,
  installGatewayTestCleanup,
  nextJson,
  nextJsonOrClose,
  service,
  start,
  streamPort,
  waitFor,
} from "./audio-streaming-test-helpers.js";

installGatewayTestCleanup();

describe("gateway persistent audio session contracts", () => {
  it("authenticates only the first frame and freezes validated session metadata at the port", async () => {
    const port = streamPort();
    const gateway = await start({ port, allowedOrigins: ["https://app.test"], production: true });
    const socket = await connect(gateway, GATEWAY_AUDIO_STREAM_PATH, "https://app.test");
    const attached = nextJson(socket);
    socket.send(attachFrame());
    expect(await attached).toEqual({
      type: "attached",
      sessionId: "meeting_1",
      generation: "generation-1",
      acceptedResumeFromSequence: null,
      latencyMode: "balanced",
    });

    expect(gateway.service.authenticate).toHaveBeenCalledWith("br_stream_secret", "org-requested");
    const input = port.openInput();
    expect(input).toMatchObject({
      owner: {
        orgId: "org-authorized",
        principalId: "user:user-1",
        sessionId: "meeting_1",
      },
      mimeType: "audio/webm;codecs=opus",
      language: "en-AU",
      latencyMode: "balanced",
      requestedResumeFromSequence: null,
      auth: { orgId: "org-authorized", userId: "user-1" },
    });
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input!.auth)).toBe(true);
    expect(JSON.stringify(input)).not.toContain("br_stream_secret");

    const wasClosed = closed(socket);
    socket.send(JSON.stringify({ type: "change", orgId: "org-attacker" }));
    expect(await wasClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.protocol);
  });

  it("requires an explicit capture organization before calling gateway authentication", async () => {
    const port = streamPort();
    const gateway = await start({ port });
    const socket = await connect(gateway);
    const result = nextJsonOrClose(socket);
    socket.send(attachFrame({ requestedOrgId: undefined }));
    expect(await result).toEqual({ kind: "close", code: GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest });
    expect(gateway.service.authenticate).not.toHaveBeenCalled();
    expect(port.open).not.toHaveBeenCalled();
  });

  it("keys active sessions by authenticated principal as well as organization and session", async () => {
    const port = streamPort();
    const svc = service();
    vi.mocked(svc.authenticate).mockImplementation(async (bearer: string) => ({
      credentialType: "api_key" as const,
      principalType: "user" as const,
      userId: bearer === "br_user_2" ? "user-2" : "user-1",
      orgId: "org-shared",
      role: "owner" as const,
      scopes: [MODEL_INVOKE_SCOPE],
    }));
    const gateway = await start({ port }, svc);

    const first = await connect(gateway);
    first.send(attachFrame({ bearer: "br_user_1", sessionId: "meeting_shared" }));
    expect(await nextJson(first)).toMatchObject({ type: "attached" });

    const duplicate = await connect(gateway);
    const duplicateClosed = closed(duplicate);
    duplicate.send(attachFrame({ bearer: "br_user_1", sessionId: "meeting_shared" }));
    expect(await duplicateClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.sessionConflict);

    const otherUser = await connect(gateway);
    const otherResult = nextJsonOrClose(otherUser);
    otherUser.send(attachFrame({ bearer: "br_user_2", sessionId: "meeting_shared" }));
    expect(await otherResult).toEqual(
      expect.objectContaining({
        kind: "message",
        value: expect.objectContaining({ type: "attached" }),
      }),
    );
    expect(port.open).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an adapter accepts unrequested, foreign, or malformed resume state", async () => {
    const cases = [
      streamPort(FULL_CAPABILITIES, { acceptedResumeFromSequence: 1 }),
      streamPort(FULL_CAPABILITIES, {
        owner: (input) => ({ ...input.owner, orgId: "org-foreign" }),
      }),
      streamPort(FULL_CAPABILITIES, { generation: "invalid generation" }),
      streamPort(FULL_CAPABILITIES, { acceptedResumeFromSequence: 0xffff_ffff }),
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const port = cases[index]!;
      const gateway = await start({ port });
      const socket = await connect(gateway);
      const result = nextJsonOrClose(socket);
      socket.send(attachFrame({ sessionId: `meeting_invalid_${index}` }));
      expect(await result).toEqual({ kind: "close", code: GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure });
      await waitFor(() => port.closeSession.mock.calls.length === 1);
    }
  });

  it("canonicalizes accepted state once and exposes persisted conflicts without adapter detail", async () => {
    const canonicalPort = streamPort();
    let generationReads = 0;
    let ownerReads = 0;
    let checkpointReads = 0;
    canonicalPort.open.mockImplementation(async (input) => ({
      session: {
        initialize: canonicalPort.initialize,
        send: canonicalPort.send,
        finish: canonicalPort.finish,
        close: canonicalPort.closeSession,
      },
      accepted: {
        owner: {
          get orgId() {
            ownerReads += 1;
            return ownerReads === 1 ? input.owner.orgId : "org-mutated";
          },
          principalId: input.owner.principalId,
          sessionId: input.owner.sessionId,
        },
        get generation() {
          generationReads += 1;
          return generationReads === 1 ? "generation-stable" : "generation-mutated";
        },
        get acceptedResumeFromSequence() {
          checkpointReads += 1;
          return checkpointReads === 1 ? null : 1;
        },
      },
    }));
    const canonicalGateway = await start({ port: canonicalPort });
    const canonicalSocket = await connect(canonicalGateway);
    canonicalSocket.send(attachFrame({ sessionId: "meeting_canonical_accept" }));
    expect(await nextJson(canonicalSocket)).toMatchObject({ generation: "generation-stable" });
    expect(generationReads).toBe(1);
    expect(ownerReads).toBe(1);
    expect(checkpointReads).toBe(1);

    const conflictPort = streamPort();
    conflictPort.open.mockRejectedValue(new GatewayAudioStreamConflictError());
    const conflictGateway = await start({ port: conflictPort });
    const conflictSocket = await connect(conflictGateway);
    const conflict = nextJsonOrClose(conflictSocket);
    conflictSocket.send(attachFrame({ sessionId: "meeting_foreign_owner" }));
    expect(await conflict).toEqual({ kind: "close", code: GATEWAY_AUDIO_STREAM_CLOSE.sessionConflict });
  });

  it("uses the adapter checkpoint as authority and forwards bootstrap plus structured chunks", async () => {
    const port = streamPort(FULL_CAPABILITIES, { acceptedResumeFromSequence: 2 });
    const gateway = await start({ port });
    const socket = await connect(gateway);
    const attached = nextJson(socket);
    socket.send(attachFrame({ resumeFromSequence: 6 }));
    expect(await attached).toMatchObject({
      type: "attached",
      generation: "generation-1",
      acceptedResumeFromSequence: 2,
    });

    socket.send(initializationFrame(Uint8Array.from([9, 8])));
    await waitFor(() => port.initialize.mock.calls.length === 1);
    expect(port.initialize).toHaveBeenCalledWith({
      mimeType: "audio/webm;codecs=opus",
      initializationSegment: Uint8Array.from([9, 8]),
    });

    socket.send(audioFrame(3, Uint8Array.from([1, 2, 3]), 9_000, 12_000));
    await waitFor(() => port.send.mock.calls.length === 1);
    expect(port.send).toHaveBeenCalledWith({
      sequence: 3,
      startMs: 9_000,
      endMs: 12_000,
      audio: Uint8Array.from([1, 2, 3]),
    });

    const partial = nextJson(socket);
    port.handlers()!.onEvent({
      kind: "partial",
      utteranceId: "utterance_1",
      revision: 0,
      text: "hel",
      startMs: 0,
      endMs: 100,
    });
    expect(await partial).toEqual({
      type: "transcript.event",
      event: {
        kind: "partial",
        utteranceId: "utterance_1",
        revision: 0,
        text: "hel",
        startMs: 0,
        endMs: 100,
      },
    });

    const final = nextJson(socket);
    port.handlers()!.onEvent({
      kind: "final",
      utteranceId: "utterance_1",
      revision: 1,
      text: "hello",
      startMs: 0,
      endMs: 300,
    });
    expect(await final).toEqual({
      type: "transcript.event",
      event: {
        kind: "final",
        utteranceId: "utterance_1",
        revision: 1,
        text: "hello",
        startMs: 0,
        endMs: 300,
      },
    });

    const coverage = nextJson(socket);
    port.handlers()!.onEvent({ kind: "coverage", coveredThroughSequence: 3 });
    expect(await coverage).toEqual({
      type: "transcript.event",
      event: { kind: "coverage", coveredThroughSequence: 3 },
    });
    const nonAuthoritativeSequence = closed(socket);
    socket.send(audioFrame(7, Uint8Array.from([4]), 12_000, 15_000));
    expect(await nonAuthoritativeSequence).toBe(GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest);
  });
});
