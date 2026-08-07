/**
 * ADR-029 B2 / Q1 — a block lock is a LEASE WITH A FENCING EPOCH, not a flag.
 *
 * The problem B2 names: D4 keeps both versions with a conflict marker, which is
 * right for a todo title and disruptive in a paragraph someone is reading. The
 * common case for a personal notes app is one person and several devices, where
 * the collision is nearly always accidental — a stale tab, a phone left open —
 * so preventing it beats merging it. A block another device is actively editing
 * is read-only with an attribution. D4 stays the floor for the case a lock
 * cannot cover: both devices offline.
 *
 * **Why an epoch, and not a lock flag.** Two failures have to be prevented at
 * once and they pull in opposite directions:
 *
 *  - A device that never comes back must not make a block permanently
 *    uneditable — so the lock EXPIRES.
 *  - An expired lock must not let that device's delayed write land on top of an
 *    edit made while it was gone — so a write carries the epoch it believes it
 *    holds, and a stale epoch is refused.
 *
 * Expiry alone gives you the second bug. That is not hypothetical here:
 * migration `048_job_lease_fencing.sql` was written after exactly it — a worker
 * held a lease, a sweeper released it, a second worker claimed the job, and the
 * first wrote its stale result over the new run. Its comment states the rule
 * this file implements one layer up: *a lease without a fencing token is not a
 * lock.*
 *
 * **Three deliberate departures from 048, each because the situation differs:**
 *
 *  1. **There is no unfenced write.** 048 spells every guard
 *     `($n IS NULL OR lease_epoch = $n)`, so a caller that omits the token is
 *     waved through — a hatch for pre-existing single-owner callers, and the
 *     source of its one live leak, a heartbeat that renews a lease with no
 *     fence and so keeps a lease its holder no longer owns looking healthy.
 *     Blocks have no legacy caller to preserve, so omitting the epoch here does
 *     not mean "trust me", it means "not claiming ownership": the write is
 *     allowed, and it gets none of an owner's privileges.
 *  2. **A refusal says WHICH refusal.** 048's complete/fail paths collapse "not
 *     running" and "wrong epoch" into `null`. B2 requires an attribution line,
 *     and "someone else is editing this" and "your lock expired" are different
 *     sentences leading to different actions.
 *  3. **A refused write is not a dropped write.** On the server a fenced write
 *     is discarded. Here the edit is a person's sentence, so a stale claim
 *     routes the write through D4's merge instead — the marker B2 calls the
 *     floor. Nothing a person typed is thrown away for holding the wrong epoch.
 *
 *     What a refusal DOES cost is the right to supersede: a fenced write cannot
 *     take the text it never saw, and if last-writer-wins would have handed it
 *     that text, both versions are kept and marked instead (`mergeNoteBlock`'s
 *     `fenced` argument). Without that, "merge instead of drop" degrades into
 *     "no fence at all", because a stale device's clock keeps running and its
 *     write arrives LATER than the one it is about to bury.
 *
 * The lease is coordination, not content: it is kept beside the blocks rather
 * than on them, and never merged by last-writer-wins. A lease that merged that
 * way would let the device with the faster clock take a lock it was refused,
 * which is the whole failure inverted.
 */

/**
 * Q1: long enough that a pause does not drop the lock mid-sentence, short
 * enough that a closed laptop frees the block before anyone notices.
 */
export const BLOCK_LEASE_MS = 30_000;

/** Renew at a third of the term, so one missed renewal does not drop the lock. */
export const BLOCK_LEASE_RENEW_MS = Math.floor(BLOCK_LEASE_MS / 3);

export interface BlockLease {
  blockId: string;
  /** The device that holds it. Ties the fence to a peer, not just to a number. */
  deviceId: string;
  /** What the attribution line says. Absent falls back to a generic phrase. */
  holder?: string;
  /**
   * Bumped by every ACQUISITION and by nothing else.
   *
   * Not by a renewal: renewing is the holder saying it is still here, and
   * changing the token then would fence the holder's own queued writes. Not by
   * a release either, for the same reason — an edit already authored under this
   * epoch is legitimate and must still be able to land.
   *
   * Acquisition covers the reclaim case on its own: whoever takes an expired
   * lease bumps past the epoch the previous holder is still carrying.
   */
  epoch: number;
  /** When the lease lapses, on the clock of whoever granted it. */
  expiresAt: number;
}

/** What a writer believes it holds. Both halves are checked; neither is optional. */
export interface LeaseClaim {
  deviceId: string;
  epoch: number;
}

export type LeaseRefusal =
  /** Another device holds a live lease. */
  | 'held_by_another'
  /** The lease was reissued since this claim was made. */
  | 'stale_epoch'
  /** The term ran out; re-acquire rather than renew. */
  | 'lease_expired'
  /** There is no lease to renew or release. */
  | 'not_held';

export type LeaseOutcome =
  | { ok: true; lease: BlockLease }
  | { ok: false; reason: LeaseRefusal; detail: string; holder?: BlockLease };

export function isLeaseLive(lease: BlockLease | undefined, nowMs: number): lease is BlockLease {
  return !!lease && lease.expiresAt > nowMs;
}

function held(lease: BlockLease): string {
  return lease.holder ?? 'another device';
}

/**
 * Take the lock, or say who has it.
 *
 * Taking it issues a NEW epoch — the same move 048's claim makes, and for the
 * same reason: any writer still carrying the previous epoch is fenced out from
 * this point on. That is what makes reclaiming an expired lease safe.
 */
export function acquireBlockLease(
  current: BlockLease | undefined,
  request: { blockId: string; deviceId: string; holder?: string },
  nowMs: number,
): LeaseOutcome {
  if (isLeaseLive(current, nowMs) && current.deviceId !== request.deviceId) {
    return {
      ok: false,
      reason: 'held_by_another',
      detail: `This block is being edited on ${held(current)}.`,
      holder: current,
    };
  }
  return {
    ok: true,
    lease: {
      blockId: request.blockId,
      deviceId: request.deviceId,
      ...(request.holder ? { holder: request.holder } : {}),
      epoch: (current?.epoch ?? 0) + 1,
      expiresAt: nowMs + BLOCK_LEASE_MS,
    },
  };
}

/**
 * Extend the term while someone is typing. The epoch does not move.
 *
 * An EXPIRED lease is not renewed even by the device that held it and even with
 * the right epoch. Between expiry and this call another device may have edited
 * the block, and quietly extending would re-establish exclusivity over content
 * this device has not seen — 048's leaked unfenced heartbeat, which keeps a
 * lease looking healthy while the wrong process is holding it up. Re-acquiring
 * is the correct move and it bumps the epoch, which is the point.
 */
export function renewBlockLease(
  current: BlockLease | undefined,
  claim: LeaseClaim,
  nowMs: number,
): LeaseOutcome {
  if (!current) {
    return { ok: false, reason: 'not_held', detail: 'There is no lock on this block to renew.' };
  }
  if (current.deviceId !== claim.deviceId) {
    return {
      ok: false,
      reason: 'held_by_another',
      detail: `The lock was taken by ${held(current)}.`,
      holder: current,
    };
  }
  if (current.epoch !== claim.epoch) {
    return {
      ok: false,
      reason: 'stale_epoch',
      detail: 'This lock was reissued — re-acquire it before continuing.',
      holder: current,
    };
  }
  if (!isLeaseLive(current, nowMs)) {
    return {
      ok: false,
      reason: 'lease_expired',
      detail: 'The lock expired. Re-acquire it; anything typed meanwhile will merge.',
      holder: current,
    };
  }
  return { ok: true, lease: { ...current, expiresAt: nowMs + BLOCK_LEASE_MS } };
}

/**
 * Give the lock back.
 *
 * Returns the lease with the term ended rather than removing it, because the
 * epoch has to survive: dropping the record resets the count, and the next
 * acquisition would mint epoch 1 again — matching the epoch a sleeping device
 * is still carrying. A fencing token that can be reset is not a fencing token.
 * `sweepBlockLeases` is the bounded way records leave.
 */
export function releaseBlockLease(
  current: BlockLease | undefined,
  claim: LeaseClaim,
  nowMs: number,
): LeaseOutcome {
  if (!current) {
    return { ok: false, reason: 'not_held', detail: 'There is no lock on this block to release.' };
  }
  if (current.deviceId !== claim.deviceId) {
    return {
      ok: false,
      reason: 'held_by_another',
      detail: `The lock belongs to ${held(current)}.`,
      holder: current,
    };
  }
  if (current.epoch !== claim.epoch) {
    return {
      ok: false,
      reason: 'stale_epoch',
      detail: 'This lock was reissued; releasing it would free someone else’s.',
      holder: current,
    };
  }
  return { ok: true, lease: { ...current, expiresAt: nowMs } };
}

export type BlockWritePath =
  /** The claim is live and correct: write the field directly. */
  | { path: 'leased'; lease: BlockLease }
  /** No exclusivity: apply through D4, which may leave a conflict marker. */
  | { path: 'merge'; reason: 'no_lease' | 'stale_epoch' | 'lease_expired'; detail: string }
  /** Someone else is typing here. B2's read-only-with-attribution. */
  | { path: 'blocked'; holder: BlockLease; detail: string };

/**
 * The fence. Every write to a block goes through this first.
 *
 * This is the function that prevents 048's defect one layer up: a device that
 * slept holding a lock wakes, flushes, and its claim no longer matches — so it
 * cannot write as the owner, and its edit merges against what happened while it
 * was gone instead of overwriting it.
 *
 * Three of the four paths refuse OWNERSHIP, not the write. `blocked`,
 * `stale_epoch` and `lease_expired` all mean "this write did not hold the
 * block", and what a caller does with that differs by WHEN it is asking:
 * before a keystroke the editor refuses (B2's read-only-with-attribution);
 * after the sentence exists it is merged and marked, because discarding it
 * would throw away a person's work to enforce a lock whose purpose is to
 * protect it. What none of them may do is silently supersede the text this
 * writer never saw — that is the whole point of the token.
 *
 * Note what is deliberately NOT here: a write with no claim at all is allowed.
 * B2 chose SOFT locking. A block nobody has locked is freely editable and D4 is
 * the floor; requiring a lease to type would turn every offline edit into a
 * refusal, which is the opposite of ADR-028 D2's whole position on offline.
 */
export function fenceBlockWrite(
  current: BlockLease | undefined,
  writer: { deviceId: string; epoch?: number },
  nowMs: number,
): BlockWritePath {
  const live = isLeaseLive(current, nowMs);

  // No epoch means the writer is not claiming ownership — it is starting a
  // fresh edit. That is the only case that can be BLOCKED, and the asymmetry is
  // about WHEN, not about entitlement: nothing has been typed yet, so refusing
  // costs nobody a sentence. An edit that already carries an epoch was typed by
  // a person before it got here, so it merges instead, however stale — and the
  // merge it goes to is a FENCED one, which is where the staleness is charged.
  if (writer.epoch === undefined) {
    if (live && current.deviceId !== writer.deviceId) {
      return {
        path: 'blocked',
        holder: current,
        detail: `This block is being edited on ${held(current)}.`,
      };
    }
    return { path: 'merge', reason: 'no_lease', detail: 'No lock is held on this block.' };
  }

  if (!current || current.deviceId !== writer.deviceId || current.epoch !== writer.epoch) {
    return {
      path: 'merge',
      reason: 'stale_epoch',
      detail: 'The lock this edit was made under has since been reissued.',
    };
  }

  if (!live) {
    return {
      path: 'merge',
      reason: 'lease_expired',
      detail: 'The lock had expired when this edit reached the block.',
    };
  }

  return { path: 'leased', lease: current };
}

/**
 * The attribution line B2 requires, or nothing when the viewer holds it.
 *
 * Returns null rather than "you are editing this", because a note that
 * announces you are typing in it is noise on the surface you are typing on.
 */
export function describeBlockLease(
  lease: BlockLease | undefined,
  viewerDeviceId: string,
  nowMs: number,
): string | null {
  if (!isLeaseLive(lease, nowMs)) return null;
  if (lease.deviceId === viewerDeviceId) return null;
  return `Being edited on ${held(lease)}`;
}

/**
 * Forget leases old enough that nothing can still contradict them.
 *
 * The epoch must outlive the lease (see `releaseBlockLease`), so records cannot
 * simply be dropped on expiry — but they must not accumulate forever either.
 * The safe bound comes from the outbox: an operation older than
 * `maxAgeMs` has already been shed and can never be flushed, so no write
 * carrying that lease's epoch exists any more, so the epoch has nothing left to
 * fence. Tying the two together means the retention cannot drift out of
 * agreement with what the queue actually keeps.
 */
export function sweepBlockLeases(
  leases: Readonly<Record<string, BlockLease>>,
  nowMs: number,
  maxAgeMs: number,
): Record<string, BlockLease> {
  const kept: Record<string, BlockLease> = {};
  for (const [blockId, lease] of Object.entries(leases)) {
    if (nowMs - lease.expiresAt <= maxAgeMs) kept[blockId] = lease;
  }
  return kept;
}
