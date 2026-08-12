/**
 * ADR-035 D10 — bounded in-process admission for persistent audio streams.
 *
 * This is deliberately an instance-local backstop, not a distributed quota
 * claim. It limits unauthenticated attach work by socket/IP, authenticated
 * concurrency globally and by IP, principal, and organization, and aggregate
 * incoming bytes per second. Every reservation is represented by one
 * idempotent lease so all counters are released through the connection's
 * single cleanup path.
 */

export interface GatewayAudioAdmissionLimits {
  readonly maxPendingStreams: number;
  readonly maxPendingStreamsPerIp: number;
  readonly maxStreams: number;
  readonly maxStreamsPerIp: number;
  readonly maxStreamsPerPrincipal: number;
  readonly maxStreamsPerOrg: number;
  readonly maxAggregateBytesPerSecond: number;
}

export interface GatewayAudioAdmissionLease {
  promote(principalId: string, orgId: string): boolean;
  consumeBytes(byteLength: number, at: number): boolean;
  release(): void;
}

type LeasePhase = "pending" | "authenticated" | "released";

function decrement(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 0) - 1;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

export class GatewayAudioAdmission {
  private pending = 0;
  private readonly pendingByIp = new Map<string, number>();
  private streams = 0;
  private readonly streamsByIp = new Map<string, number>();
  private readonly streamsByPrincipal = new Map<string, number>();
  private readonly streamsByOrg = new Map<string, number>();
  private byteWindowStartedAt = 0;
  private byteWindowTotal = 0;

  constructor(private readonly limits: GatewayAudioAdmissionLimits) {}

  tryAcquirePending(ip: string): GatewayAudioAdmissionLease | null {
    if (
      this.pending >= this.limits.maxPendingStreams ||
      (this.pendingByIp.get(ip) ?? 0) >= this.limits.maxPendingStreamsPerIp
    ) {
      return null;
    }
    this.pending += 1;
    this.pendingByIp.set(ip, (this.pendingByIp.get(ip) ?? 0) + 1);
    let phase: LeasePhase = "pending";
    let principalId = "";
    let orgId = "";

    const releasePending = (): void => {
      this.pending -= 1;
      decrement(this.pendingByIp, ip);
    };

    return {
      promote: (nextPrincipalId, nextOrgId): boolean => {
        if (phase !== "pending") return false;
        if (
          this.streams >= this.limits.maxStreams ||
          (this.streamsByIp.get(ip) ?? 0) >= this.limits.maxStreamsPerIp ||
          (this.streamsByPrincipal.get(nextPrincipalId) ?? 0) >= this.limits.maxStreamsPerPrincipal ||
          (this.streamsByOrg.get(nextOrgId) ?? 0) >= this.limits.maxStreamsPerOrg
        ) {
          return false;
        }
        releasePending();
        phase = "authenticated";
        principalId = nextPrincipalId;
        orgId = nextOrgId;
        this.streams += 1;
        this.streamsByIp.set(ip, (this.streamsByIp.get(ip) ?? 0) + 1);
        this.streamsByPrincipal.set(principalId, (this.streamsByPrincipal.get(principalId) ?? 0) + 1);
        this.streamsByOrg.set(orgId, (this.streamsByOrg.get(orgId) ?? 0) + 1);
        return true;
      },
      consumeBytes: (byteLength, at): boolean => {
        if (phase !== "authenticated" || !Number.isSafeInteger(byteLength) || byteLength <= 0) return false;
        if (at < this.byteWindowStartedAt || at - this.byteWindowStartedAt >= 1_000) {
          this.byteWindowStartedAt = at;
          this.byteWindowTotal = 0;
        }
        if (this.byteWindowTotal + byteLength > this.limits.maxAggregateBytesPerSecond) return false;
        this.byteWindowTotal += byteLength;
        return true;
      },
      release: (): void => {
        if (phase === "released") return;
        if (phase === "pending") releasePending();
        if (phase === "authenticated") {
          this.streams -= 1;
          decrement(this.streamsByIp, ip);
          decrement(this.streamsByPrincipal, principalId);
          decrement(this.streamsByOrg, orgId);
        }
        phase = "released";
      },
    };
  }
}
