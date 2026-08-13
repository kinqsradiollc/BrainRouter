/**
 * ADR-028 D3 — hybrid logical clocks, because device wall clocks lie.
 *
 * Ordering by `Date.now()` is the specific mistake this exists to prevent. A
 * laptop five minutes fast wins every conflict it participates in — silently,
 * permanently, and in a way nobody can diagnose from the outcome, because the
 * result looks exactly like "that edit was later".
 *
 * An HLC keeps the useful property of a wall clock (stamps roughly track real
 * time, so they are readable and sortable against timestamps from elsewhere)
 * while guaranteeing the property a wall clock lacks: it never goes backwards,
 * and it absorbs the highest clock it has seen from any peer. A device that is
 * fast pulls everyone forward once and then stops mattering; a device that is
 * slow catches up on first contact.
 *
 * ADR-027 D12 moved lease expiry onto the database clock for this same reason.
 * This is that decision extended to where the database clock is unreachable —
 * which is the entire point of an offline-first surface.
 *
 * It lives under `sync/` rather than under the planner because ADR-029 B3 makes
 * it shared: Notes reuses this stack rather than growing a second one, and two
 * sync systems in one product disagree in ways that are indistinguishable from
 * a bug in whichever surface you happen to be looking at.
 */

export interface Hlc {
  /** Milliseconds since epoch, as far as this device believes. */
  physical: number;
  /** Disambiguates events within the same millisecond. */
  logical: number;
  /** Final tie-break, so ordering is total rather than merely partial. */
  deviceId: string;
}

export function hlcZero(deviceId: string): Hlc {
  return { physical: 0, logical: 0, deviceId };
}

/**
 * Total order over stamps.
 *
 * Total, not partial, and deliberately so: last-writer-wins needs an
 * unambiguous winner or two devices resolve the same pair differently and
 * converge on nothing. The device tie-break is arbitrary but *consistent*,
 * which is the property that matters.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId < b.deviceId ? -1 : 1;
}

export function hlcAfter(a: Hlc, b: Hlc): boolean {
  return compareHlc(a, b) > 0;
}

/** Same event, or two stamps that must be treated as concurrent. */
export function hlcConcurrent(a: Hlc, b: Hlc): boolean {
  return a.physical === b.physical && a.logical === b.logical && a.deviceId !== b.deviceId;
}

/**
 * Stamp a local event.
 *
 * The `Math.max` is the whole mechanism: if the wall clock has gone backwards
 * — NTP correction, a suspended laptop, a user changing the date — the stamp
 * does not. It advances the logical counter instead, so events keep their
 * order even while the physical clock is wrong.
 */
export function hlcNow(previous: Hlc, wallClockMs: number): Hlc {
  const physical = Math.max(previous.physical, wallClockMs);
  const logical = physical === previous.physical ? previous.logical + 1 : 0;
  return { physical, logical, deviceId: previous.deviceId };
}

/**
 * Absorb a stamp received from a peer.
 *
 * Taking the highest clock seen is what makes the fast device stop winning:
 * after one exchange everyone is at its clock, so its advantage is spent rather
 * than renewed on every subsequent edit.
 *
 * The received stamp keeps its own `deviceId`; the returned one carries ours,
 * because this is *our* clock after having seen theirs.
 */
export function hlcReceive(local: Hlc, remote: Hlc, wallClockMs: number): Hlc {
  const physical = Math.max(local.physical, remote.physical, wallClockMs);
  let logical: number;
  if (physical === local.physical && physical === remote.physical) {
    logical = Math.max(local.logical, remote.logical) + 1;
  } else if (physical === local.physical) {
    logical = local.logical + 1;
  } else if (physical === remote.physical) {
    logical = remote.logical + 1;
  } else {
    // The wall clock moved past both; nothing to disambiguate against.
    logical = 0;
  }
  return { physical, logical, deviceId: local.deviceId };
}

/**
 * How far ahead of us a peer's clock is, in milliseconds.
 *
 * Reported rather than silently absorbed. A peer an hour ahead is a
 * misconfigured device, and the correct response is to say so — the HLC will
 * keep ordering correct either way, but every stamp in that window will look
 * like it came from the future, and a human comparing the planner against their
 * calendar deserves to know why.
 */
export function clockSkewMs(local: Hlc, remote: Hlc): number {
  return Math.max(0, remote.physical - local.physical);
}

/** Skew worth telling someone about. Below this it is ordinary drift. */
export const NOTABLE_SKEW_MS = 5 * 60 * 1000;

export function describeSkew(skewMs: number): string | null {
  if (skewMs < NOTABLE_SKEW_MS) return null;
  const minutes = Math.round(skewMs / 60_000);
  return (
    `Another device's clock is about ${minutes} minute${minutes === 1 ? '' : 's'} ahead of this one. ` +
    'Ordering is still correct, but items from it will look like they were edited slightly in the future.'
  );
}

/*
 * A `formatHlc`/`parseHlc` pair encoded a stamp as `physical.logical.device`
 * and was **retired 2026-08-12**: no caller, on either side of the wire. Every
 * stamp that crosses the boundary crosses as an OBJECT, validated by
 * `planner/wireContract.ts:isPlannerWireHlc` and stored column-per-field by
 * migration 051 — so the string form was a second encoding of the same value
 * with nobody to disagree with yet. A `deviceId` containing a dot would have
 * round-tripped wrong the first time anyone used it.
 */
