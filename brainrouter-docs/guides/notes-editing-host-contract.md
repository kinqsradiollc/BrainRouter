# Notes editing host contract

The Dashboard Notes editor uses one authenticated host seam:

- `GET /api/notes/mutate/capabilities`
- `POST /api/notes/mutate`

The shared types, capability document, pure gesture/database planners, and
runtime parser are exported from `@kinqs/brainrouter-core/notes/editing`.
Browser code must not import the broad `@kinqs/brainrouter-core/notes` entry;
that entry also contains the filesystem-backed local store.

## Request

Every write is one versioned, retryable envelope:

```ts
interface NotesMutationRequest {
  version: 1;
  requestId: string; // stable across retries
  deviceId: string;  // stable editor/device identity and lease identity
  operation: NotesMutationOperation;
}
```

`requestId` is the idempotency root. Reusing it for a retry cannot apply a
split, duplicate, comment, or database write twice. Do not reuse it for a new
intention.

`orgId` and `userId` are intentionally absent. The route derives both from the
authenticated request and strips unexpected top-level fields during parsing;
a browser cannot choose another Notes partition in its JSON body.

The operation union contains:

- blocks: `block.create`, `block.update`, `block.delete`, `block.restore`,
  `block.move`;
- gestures: `gesture.split`, `gesture.merge`, `gesture.duplicate`,
  `gesture.indent`, `gesture.outdent`, `gesture.move`;
- leases: `lease.acquire`, `lease.renew`, `lease.release`;
- comments: `comment.add`, `comment.edit`, `comment.resolve`, `comment.delete`;
- conflicts/templates: `conflict.resolve`, `template.instantiate`;
- database rows: `database.row.create`, `database.row.set`,
  `database.row.delete`;
- database schema/views: `database.property.add`,
  `database.property.update`, `database.property.delete`,
  `database.property.reorder`, `database.view.save`, `database.view.delete`;
- history: `history.state`, `history.undo`, `history.redo`;
- explicit capability probe: `attachment.upload-bytes`.

Use the exact `NotesMutationOperation` union instead of recreating these payload
shapes in the adapter. `parseNotesMutationRequest` is the runtime boundary for
HTTP and IPC hosts.

Generic `block.create` and `block.update` never accept `props`, `schema`, or
`views`. Database values, properties, and views must use their dedicated
operations so Core's coercion and schema/view invariants cannot be bypassed.
Marking or unmarking a template is the ordinary `block.update` operation with
`patch: { template: boolean }`. Instantiation is a distinct intention because
it copies a subtree, remaps internal references, and returns Core's explanation
of that rewrite.

The three editor callbacks that cannot be expressed as ordinary field writes
have these result shapes:

- `block.restore` returns `{ restoredIds: string[] }`, including deleted
  descendants restored with the root;
- `conflict.resolve` returns `{ block }`, refreshed after keeping `ours` or
  `theirs` for the named field;
- `template.instantiate` returns
  `{ ok: true, pageId, blocks, rewritten, line }`, where `line` is Core's
  user-facing description of the copy and reference rewrites.

The rollup picker reads
`GET /api/notes/databases/:id/rollup-targets?relation=<propertyId>`. It returns
`{ ok: true, properties: [{ id, name, type }], databases: [{ id, title }] }`
from the authenticated user's reachable relation targets. The server and local
host both execute `rollupTargetPropertiesFromBlocks`; a Dashboard adapter must
not derive this list with a second relation traversal.

The shared sidebar reads complete authenticated projections rather than trying
to reconstruct tombstones from bounded sync responses:

- `GET /api/notes/trash` returns
  `{ entries: [{ id, kind, title, descendants, deletedAt, line }] }`;
- `GET /api/notes/comments/orphaned` returns
  `{ threads: [{ blockId, text, comments }] }`, with each comment flattened to
  `{ id, body, author, resolved, createdAtMs }`.

Both routes derive from Core over every block in the authenticated `(org,user)`
partition. `/blocks` intentionally contains only live blocks, and `/pull` is a
bounded sync feed; neither is an honest source for a complete trash/sidebar
projection.

## Response and reconciliation

Every response is `NotesMutationResponse` and always includes:

```ts
{
  version: 1;
  requestId: string;
  operation: NotesMutationOperationType | "unknown";
  ok: boolean;
  sync: {
    accepted: string[];
    rejected: Array<{ idempotencyKey: string; reason: string }>;
    fenced: Array<{ idempotencyKey: string; itemId: string; reason: string }>;
  };
  history: NotesRemoteHistoryState;
}
```

An `ok: true` response has `result`; an `ok: false` response has a typed
`error` with `code`, `detail`, and `retryable`.

The adapter must reconcile in this order:

1. Apply `planNoteGesture` optimistically for a gesture if desired. It is the
   same pure policy the server executes.
2. Send the versioned request.
3. On `sync.rejected`, keep/report the refusal and reload the affected block.
4. On `sync.fenced`, show that the write merged under a lease refusal and reload
   the affected block. `accepted` does not mean the visible text superseded the
   server text.
5. A retry with the same request and a current receipt returns the original
   typed response byte-for-byte, so reconcile it exactly as the first response
   and never apply an optimistic plan twice. Only a legacy receipt can return
   `result.replayed === true` with `refreshRequired: true`; reload the affected
   page/block because that older receipt did not retain its result.

HTTP status is transport guidance, not a substitute for the typed body:

- `200`: applied, replayed, or an honest `history.state` result;
- `400`: malformed or over-bound request;
- `404`: scoped block/comment/database item not found;
- `409`: lock, policy, or primitive sync refusal;
- `422`: a named unsupported capability;
- `500`: unexpected server failure (`retryable: true`).

## Lease-fenced edits

`NotesOps.beginEdit(id)` is asynchronous and returns `Promise<boolean>`. The
shared editor remains read-only while that promise is pending and becomes
editable only after `true`; a refusal stays read-only and exposes the holder or
error. Use the same `deviceId` for the lease and mutation requests. Send the
returned epoch on `block.update`, `gesture.split`, `gesture.merge`,
`database.row.set`, and schema/view mutations. The server still applies the
ordinary merge policy; a valid epoch removes the fencing penalty, while a
stale, expired, or other-device claim is reported in `sync.fenced` rather than
silently dropping a person's text.

Conflict resolution is compare-and-set, not a blind overwrite. The shared
conflict view passes the exact `oursAt` and `theirsAt` clocks it displayed in
`conflict.resolve.expected`; if either endpoint changed, the host refuses the
choice and refreshes the block so a person never resolves an unseen version.

## Honest unsupported capabilities

Remote undo/redo is not emulated. Local history belongs to one device, while
the server has no per-device inverse stack. `history.state` returns
`canUndo: false` and `canRedo: false`; `history.undo` and `history.redo` return
`unsupported_capability` with capability `remote_history`.

Attachment bytes also require a native/object-storage upload transport.
`attachment.upload-bytes` returns `unsupported_capability` with capability
`attachment_bytes`; it never returns a successful stub. Existing attachment
metadata/link routes remain available.

## Existing device sync

`POST /api/notes/push` remains backwards compatible. The mutation host converts
high-level intentions into the same `NotePushOperation` path, so server merge,
HLC ordering, lease fencing, derived projections, and rejection reporting have
one implementation rather than a Dashboard-only writer.
