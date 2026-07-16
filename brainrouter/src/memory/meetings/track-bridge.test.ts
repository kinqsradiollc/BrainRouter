import { beforeEach, describe, expect, it, vi } from "vitest";

// The meeting→Track bridge orchestrates the real track backend over a mocked store,
// so this exercises createTrack/untrackBySourceRef end to end (not just the meeting fns).
const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(),
  updateMeetingActionItems: vi.fn(),
  createTrackItem: vi.fn(),
  getTrackItemBySourceRef: vi.fn(),
  deleteTrackItem: vi.fn(),
}));

vi.mock("../engine.js", () => ({
  memoryEngine: {
    store: {
      getMeeting: mocks.getMeeting,
      updateMeetingActionItems: mocks.updateMeetingActionItems,
      createTrackItem: mocks.createTrackItem,
      getTrackItemBySourceRef: mocks.getTrackItemBySourceRef,
      deleteTrackItem: mocks.deleteTrackItem,
    },
  },
}));

import { trackMeetingAction, untrackMeetingAction, setActionItemState } from "./backend.js";

function meeting(actionItems: Array<Record<string, unknown>>) {
  return { id: "m1", orgId: "org-1", userId: "user-1", actionItems };
}

describe("meeting → Track bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMeetingActionItems.mockResolvedValue(true);
    mocks.getTrackItemBySourceRef.mockResolvedValue(null);
    mocks.createTrackItem.mockImplementation(async (input: Record<string, unknown>) => ({ ...input, id: "wi_new" }));
    mocks.deleteTrackItem.mockResolvedValue(true);
  });

  it("tracking a meeting action creates a REAL work item (sourceRef) and links it back", async () => {
    mocks.getMeeting.mockResolvedValue(meeting([{ id: "a1", title: "Email the vendor", done: false }]));
    const result = await trackMeetingAction("user-1", "org-1", "m1", "a1");
    expect(result?.trackItemId).toBe("wi_new");
    // The created item carries the meeting linkage + title.
    const created = mocks.createTrackItem.mock.calls[0]![0];
    expect(created.source).toBe("meeting-action");
    expect(created.sourceRef).toBe("m1:a1");
    expect(created.title).toBe("Email the vendor");
    // The action is linked back to the real item id.
    const persisted = mocks.updateMeetingActionItems.mock.calls[0]![2];
    expect(persisted.find((a: { id: string }) => a.id === "a1").trackItemId).toBe("wi_new");
  });

  it("re-tracking is idempotent — returns the existing item, creates nothing new", async () => {
    mocks.getMeeting.mockResolvedValue(meeting([{ id: "a1", title: "X", done: false, trackItemId: "wi_old" }]));
    mocks.getTrackItemBySourceRef.mockResolvedValue({ id: "wi_old", orgId: "org-1" });
    const result = await trackMeetingAction("user-1", "org-1", "m1", "a1");
    expect(result?.trackItemId).toBe("wi_old");
    expect(mocks.createTrackItem).not.toHaveBeenCalled();
  });

  it("untracking deletes the linked work item and clears the link", async () => {
    mocks.getMeeting.mockResolvedValue(meeting([{ id: "a1", title: "X", done: false, trackItemId: "wi_old" }]));
    mocks.getTrackItemBySourceRef.mockResolvedValue({ id: "wi_old", orgId: "org-1" });
    const ok = await untrackMeetingAction("user-1", "org-1", "m1", "a1");
    expect(ok).toBe(true);
    expect(mocks.deleteTrackItem).toHaveBeenCalledWith("org-1", "wi_old");
    // The action no longer carries a trackItemId.
    const persisted = mocks.updateMeetingActionItems.mock.calls[0]![2];
    expect(persisted.find((a: { id: string }) => a.id === "a1").trackItemId).toBeUndefined();
  });

  it("setActionItemState can CLEAR the link with trackItemId: null", async () => {
    mocks.getMeeting.mockResolvedValue(meeting([{ id: "a1", title: "X", trackItemId: "wi_old" }]));
    await setActionItemState("user-1", "org-1", "m1", "a1", { trackItemId: null });
    const persisted = mocks.updateMeetingActionItems.mock.calls[0]![2];
    expect(persisted.find((a: { id: string }) => a.id === "a1").trackItemId).toBeUndefined();
  });
});
