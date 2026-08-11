/** Pure address constructors used by Notes pickers and selection actions. */
export function noteBlockUri(blockId: string): string {
  return `brainrouter://notes/block/${blockId}`;
}

export function plannerItemUri(itemId: string): string {
  return `brainrouter://planner/item/${itemId}`;
}

export function workItemUri(keyOrId: string): string {
  return `brainrouter://track/work-item/${keyOrId}`;
}

export function meetingUri(meetingId: string): string {
  return `brainrouter://meetings/meeting/${meetingId}`;
}
