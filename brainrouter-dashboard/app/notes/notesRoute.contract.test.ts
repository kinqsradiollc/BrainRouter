import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isQuickFindShortcut } from "@kinqs/brainrouter-ui/notes";

const route = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const host = readFileSync(new URL("./useDashboardNotes.ts", import.meta.url), "utf8");

test("ADR-038 Dashboard mounts the shared Notes renderer under the existing auth route", () => {
  assert.match(route, /import\s*\{[\s\S]*NotesMode[\s\S]*isQuickFindShortcut[\s\S]*\}\s*from "@kinqs\/brainrouter-ui\/notes"/);
  assert.match(route, /import "@kinqs\/brainrouter-ui\/notes\.css"/);
  assert.match(route, /export default function NotesPage/);
  assert.match(route, /<AuthGuard>[\s\S]*<DashboardNotes\s*\/>[\s\S]*<\/AuthGuard>/);
  assert.equal((route.match(/<NotesMode\b/g) ?? []).length, 1);
  assert.doesNotMatch(route, /contentEditable|tableCells|notes\.module\.css|switch\s*\(.*kind/);
});

test("ADR-038 Dashboard delegates the global quick-find gesture to the shared key contract", () => {
  assert.equal(isQuickFindShortcut({ key: "k", metaKey: true, ctrlKey: false }), true);
  assert.equal(isQuickFindShortcut({ key: "K", metaKey: false, ctrlKey: true }), true);
  assert.equal(isQuickFindShortcut({ key: "k", metaKey: false, ctrlKey: false }), false);
  assert.match(route, /if \(!isQuickFindShortcut\(event\)\) return/);
  assert.doesNotMatch(route, /event\.key\s*===|event\.metaKey\s*\|\||event\.ctrlKey\s*\|\|/);
});

test("ADR-038 host uses authenticated active-org reads, bounded invalidation, and the canonical mutation seam", () => {
  assert.doesNotMatch(host, /@kinqs\/brainrouter-core/);
  assert.match(host, /useActiveOrg\(\)/);
  assert.match(host, /const POLL_MS = 5_000/);
  assert.match(host, /setInterval\(tick, POLL_MS\)/);
  assert.match(host, /authFetch<NotesEditingCapabilities>\("\/api\/notes\/mutate\/capabilities", \{ orgId \}\)/);
  assert.match(host, /authFetch<unknown>\("\/api\/notes\/mutate"/);
  assert.match(host, /scope\.current !== orgId/);
  assert.match(host, /sequence !== loadSequence\.current/);
  assert.match(host, /const beginEdit = useCallback\(\(id: string\): Promise<boolean>/);
  assert.match(host, /notesLeaseGrant\(acquired\.result, id, dashboardDeviceId\(\)\)/);
  assert.match(host, /return true;[\s\S]*setRemoteLock\(id,[\s\S]*return false;/);
  assert.match(host, /resolveConflict: \(id, field, keep, expected\)/);
  assert.match(host, /type: "conflict\.resolve",[\s\S]*expected,/);
});

test("ADR-038 mandatory browser operations are real routes or visibly unavailable capabilities", () => {
  assert.match(host, /authFetch<unknown>\("\/api\/workspace\/create"/);
  assert.match(host, /\/api\/notes\/backlinks\?target=/);
  assert.match(host, /\/api\/notes\/search\?q=/);
  assert.match(host, /\/api\/workspace\/resolve\?uri=/);
  assert.match(host, /\/api\/planner\/items/);
  assert.match(host, /\/api\/track/);
  assert.match(host, /\/api\/meetings\?limit=100/);
  assert.match(host, /files: \[\]/);
  assert.match(host, /Code-file links require a checked-out workspace and are unavailable in the Dashboard/);
  assert.match(host, /Remote undo and redo are unavailable in the Dashboard/);
  assert.match(host, /Dashboard does not pretend to upload files/);
  assert.doesNotMatch(host, /history:\s*\{|images:\s*\{/);
});

test("ADR-038 every remotely supported editor primitive reaches the typed operation union", () => {
  for (const operation of [
    "block.create", "block.update", "block.delete", "block.move", "block.restore",
    "gesture.split", "gesture.merge", "gesture.duplicate", "gesture.move", "gesture.indent", "gesture.outdent",
    "lease.acquire", "lease.renew", "lease.release",
    "comment.add", "comment.edit", "comment.resolve", "comment.delete",
    "database.row.create", "database.row.set", "database.row.delete",
    "database.property.add", "database.property.update", "database.property.delete", "database.property.reorder",
    "database.view.save", "database.view.delete", "conflict.resolve", "template.instantiate",
  ]) {
    assert.match(host, new RegExp(`type: ["']${operation.split(".").join("\\.")}["']`), operation);
  }
});
