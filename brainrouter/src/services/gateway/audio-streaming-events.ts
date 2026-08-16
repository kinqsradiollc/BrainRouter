/**
 * ADR-035 D10 — canonical transcript-event buffering and coverage gating.
 *
 * Adapter events can arrive during open or synchronously from a chunk send.
 * This channel snapshots them once, keeps the attach response first, withholds
 * events until the corresponding send succeeds, and admits coverage only up to
 * the highest chunk actually delivered to the adapter.
 */
import type { MeetingStreamingTranscriptEvent } from "@kinqs/brainrouter-core/meetings";

import { canonicalizeGatewayAudioEvent, GATEWAY_AUDIO_STREAM_CLOSE } from "./audio-streaming-protocol.js";

const MAX_PENDING_TRANSCRIPTS = 32;

export type GatewayAudioEventFailure = (code: number, reason: string) => void;
export type GatewayAudioEventSender = (event: MeetingStreamingTranscriptEvent) => void;

export class GatewayAudioEventChannel {
  private acceptedStateReady = false;
  private attached = false;
  private sendInFlight = false;
  private coveredThroughSequence = -1;
  private highestDeliveredSequence = -1;
  private readonly pending: MeetingStreamingTranscriptEvent[] = [];

  constructor(
    private readonly send: GatewayAudioEventSender,
    private readonly fail: GatewayAudioEventFailure,
  ) {}

  accept(value: unknown): void {
    const event = canonicalizeGatewayAudioEvent(value);
    if (!event) {
      this.fail(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure, "invalid transcription event");
      return;
    }
    if (!this.acceptedStateReady || !this.attached || this.sendInFlight) {
      this.queue(event);
      return;
    }
    this.emit(event);
  }

  acceptResume(sequence: number | null): void {
    this.coveredThroughSequence = sequence ?? -1;
    this.highestDeliveredSequence = this.coveredThroughSequence;
    this.acceptedStateReady = true;
  }

  markAttached(): void {
    this.attached = true;
  }

  beginDelivery(): number {
    this.sendInFlight = true;
    return this.pending.length;
  }

  deliverySucceeded(sequence: number | null): void {
    if (sequence !== null) this.highestDeliveredSequence = sequence;
    this.sendInFlight = false;
    this.flush();
  }

  deliveryFailed(pendingStart: number): void {
    this.pending.splice(pendingStart);
    this.sendInFlight = false;
  }

  flush(): void {
    if (!this.acceptedStateReady || !this.attached || this.sendInFlight) return;
    const pending = this.pending.splice(0);
    for (const event of pending) {
      if (!this.emit(event)) {
        this.pending.length = 0;
        return;
      }
    }
  }

  private queue(event: MeetingStreamingTranscriptEvent): void {
    if (this.pending.length >= MAX_PENDING_TRANSCRIPTS) {
      this.fail(GATEWAY_AUDIO_STREAM_CLOSE.overloaded, "stream output limit exceeded");
      return;
    }
    this.pending.push(event);
  }

  private emit(event: MeetingStreamingTranscriptEvent): boolean {
    if (event.kind === "coverage") {
      const checkpoint = event.coveredThroughSequence;
      if (checkpoint < this.coveredThroughSequence || checkpoint > this.highestDeliveredSequence) {
        this.fail(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure, "invalid transcript coverage");
        return false;
      }
      this.coveredThroughSequence = checkpoint;
    }
    this.send(event);
    return true;
  }
}
