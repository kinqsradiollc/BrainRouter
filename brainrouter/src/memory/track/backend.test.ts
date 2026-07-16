import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTrackItem: vi.fn(),
  getTrackItemBySourceRef: vi.fn(),
  deleteTrackItem: vi.fn(),
}));

vi.mock("../engine.js", () => ({
  memoryEngine: {
    store: {
      createTrackItem: mocks.createTrackItem,
      getTrackItemBySourceRef: mocks.getTrackItemBySourceRef,
      deleteTrackItem: mocks.deleteTrackItem,
    },
  },
}));

import { createTrack, untrackBySourceRef } from "./backend.js";

const existing = { id: "wi_existing", orgId: "org-1" } as never;

describe("track backend — meeting→track idempotency + untrack", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reuses the existing item for a meeting sourceRef instead of creating a duplicate", async () => {
    mocks.getTrackItemBySourceRef.mockResolvedValue(existing);
    const item = await createTrack("org-1", "user-1", { title: "Follow up", source: "meeting-action", sourceRef: "m1:a1" });
    expect(item).toBe(existing);
    expect(mocks.createTrackItem).not.toHaveBeenCalled();
  });

  it("creates a new item when the sourceRef has no existing track item", async () => {
    mocks.getTrackItemBySourceRef.mockResolvedValue(null);
    mocks.createTrackItem.mockResolvedValue({ id: "wi_new" });
    await createTrack("org-1", "user-1", { title: "Follow up", source: "meeting-action", sourceRef: "m1:a2" });
    expect(mocks.createTrackItem).toHaveBeenCalledTimes(1);
    const arg = mocks.createTrackItem.mock.calls[0]![0];
    expect(arg.orgId).toBe("org-1");
    expect(arg.sourceRef).toBe("m1:a2");
    expect(arg.source).toBe("meeting-action");
  });

  it("rejects an empty title", async () => {
    await expect(createTrack("org-1", "user-1", { title: "   " })).rejects.toThrow(/title/i);
  });

  it("untrack removes the item for a sourceRef and returns its id", async () => {
    mocks.getTrackItemBySourceRef.mockResolvedValue(existing);
    mocks.deleteTrackItem.mockResolvedValue(true);
    const id = await untrackBySourceRef("org-1", "m1:a1");
    expect(id).toBe("wi_existing");
    expect(mocks.deleteTrackItem).toHaveBeenCalledWith("org-1", "wi_existing");
  });

  it("untrack is a no-op (null) when nothing is linked", async () => {
    mocks.getTrackItemBySourceRef.mockResolvedValue(null);
    const id = await untrackBySourceRef("org-1", "m1:none");
    expect(id).toBeNull();
    expect(mocks.deleteTrackItem).not.toHaveBeenCalled();
  });
});
