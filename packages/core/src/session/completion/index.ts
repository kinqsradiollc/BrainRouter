// Completion concern — the in-process queue that lets detached background actors
// (workers, delegated children, backgrounded workflows) report back to the parent
// session's next turn. Re-exported by the parent `session` barrel.
export * from './completionInbox.js';
