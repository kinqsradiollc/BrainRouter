/**
 * Repository evidence verification (ADR-056 D-A3).
 *
 * An element may claim `sources` — repo-relative paths, optional line ranges —
 * that it reflects. Verification resolves ONE revision (an explicit request,
 * the document's own `meta.repository.revision`, else HEAD), reads the tree at
 * that revision with a single `git ls-tree`, and checks every claimed path (and
 * that a claimed line range fits the file). A source that holds is stamped
 * with the revision; an element whose sources all hold becomes `verified`, one
 * with any failure becomes `unverified`, and one with no sources stays
 * `authored`. Failures are WARNINGS with the path named and the repairs
 * offered — an unverifiable claim never blocks a render; it stays visible as
 * what it is.
 *
 * Only git is consulted, never the working tree: evidence is a statement about
 * a revision a reader can check out, not about whatever happens to be on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Diagram, DiagramDiagnostic, DiagramElement, DiagramSource } from '@kinqs/brainrouter-types';
import { findGitRoot, gitHeadSha, readGitRemoteUrl } from '../git/workspaceGit.js';

export interface EvidenceCounts { verified: number; unverified: number; unsourced: number }

export interface EvidenceVerification {
  /** True when every sourced element verified (unsourced elements do not count against it). */
  ok: boolean;
  /** The document with `revision` stamped on verified sources and `evidence` set per element. */
  diagram: Diagram;
  revision?: string;
  counts: EvidenceCounts;
  diagnostics: DiagramDiagnostic[];
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 20_000;

function git(gitRoot: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', gitRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Every element array of a document that can carry `sources`, with its JSON path prefix. */
function sourcedArrays(doc: Diagram): Array<{ name: string; items: DiagramElement[] }> {
  switch (doc.kind) {
    case 'architecture': return [{ name: 'components', items: doc.components }, { name: 'connections', items: doc.connections }];
    case 'workflow': return [{ name: 'nodes', items: doc.nodes }, { name: 'edges', items: doc.edges }];
    case 'sequence': return [{ name: 'participants', items: doc.participants }, { name: 'messages', items: doc.messages }];
    case 'dataflow': return [{ name: 'nodes', items: doc.nodes }, { name: 'flows', items: doc.flows }];
    case 'lifecycle': return [{ name: 'states', items: doc.states }, { name: 'transitions', items: doc.transitions }];
  }
}

function warn(code: string, at: string, message: string, fixes: string[]): DiagramDiagnostic {
  return { code, severity: 'warning', path: at, message, supportedFixes: fixes };
}

/** Line count of a blob at a revision, or -1 when unreadable. */
function blobLines(gitRoot: string, revision: string, gitPath: string): number {
  const r = git(gitRoot, ['show', `${revision}:${gitPath}`]);
  if (!r.ok) return -1;
  if (r.out === '') return 0;
  return r.out.endsWith('\n') ? r.out.split('\n').length - 1 : r.out.split('\n').length;
}

/**
 * Verify a validated document's sources against the repository containing
 * `workspaceRoot`. Never throws; a workspace outside any repository marks every
 * sourced element unverified with one diagnostic saying why.
 */
export function verifyDiagramEvidence(input: Diagram, workspaceRoot: string, opts: { revision?: string } = {}): EvidenceVerification {
  const doc = structuredClone(input);
  const diagnostics: DiagramDiagnostic[] = [];
  const counts: EvidenceCounts = { verified: 0, unverified: 0, unsourced: 0 };
  const arrays = sourcedArrays(doc);
  const gitRoot = findGitRoot(workspaceRoot);

  const finish = (revision?: string): EvidenceVerification => {
    diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
    return { ok: counts.unverified === 0, diagram: doc, ...(revision ? { revision } : {}), counts, diagnostics };
  };

  if (!gitRoot) {
    for (const { name, items } of arrays) {
      items.forEach((el, i) => {
        if (!el.sources?.length) { counts.unsourced++; return; }
        el.evidence = 'unverified'; counts.unverified++;
        diagnostics.push(warn('diagram/evidence-no-repository', `${name}[${i}].sources`, 'The workspace is not inside a git repository, so its sources cannot be verified at a revision.', ['initialise or open the repository', 'remove the sources']));
      });
    }
    return finish();
  }

  const requested = opts.revision ?? doc.meta.repository?.revision;
  let revision = requested ?? gitHeadSha(gitRoot);
  if (!revision || !FULL_SHA.test(revision) || !git(gitRoot, ['cat-file', '-e', `${revision}^{commit}`]).ok) {
    const head = gitHeadSha(gitRoot);
    if (requested) diagnostics.push(warn('diagram/evidence-unknown-revision', 'meta.repository.revision', `Revision ${requested} is not a commit in this repository; HEAD was used instead.`, ['set meta.repository.revision to a reachable commit', 'omit it to use HEAD']));
    revision = head;
  }
  if (!revision) {
    for (const { items } of arrays) items.forEach((el) => { if (el.sources?.length) { el.evidence = 'unverified'; counts.unverified++; } else counts.unsourced++; });
    diagnostics.push(warn('diagram/evidence-no-revision', 'meta.repository.revision', 'The repository has no commits yet, so nothing can be verified.', ['commit the files the diagram cites']));
    return finish();
  }

  const tree = new Set(git(gitRoot, ['ls-tree', '-r', '--name-only', '-z', revision]).out.split('\0').filter(Boolean));
  // Both sides through realpath: a workspace reached via a symlink (macOS's
  // /var → /private/var temp dirs, a linked checkout) must map onto the tree
  // paths git reports, or every source looks absent.
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const prefix = path.relative(real(gitRoot), real(workspaceRoot)).split(path.sep).filter((s) => s && s !== '.').join('/');
  const toGitPath = (p: string): string => (prefix ? `${prefix}/${p}` : p);

  for (const { name, items } of arrays) {
    items.forEach((el, i) => {
      if (!el.sources?.length) { counts.unsourced++; return; }
      let allOk = true;
      el.sources.forEach((src: DiagramSource, j) => {
        const at = `${name}[${i}].sources[${j}]`;
        const gitPath = toGitPath(src.path);
        if (!tree.has(gitPath)) {
          allOk = false;
          diagnostics.push(warn('diagram/evidence-missing-path', `${at}.path`, `"${src.path}" does not exist at ${revision.slice(0, 12)}.`, ['correct the path', 'commit the file', 'remove the source']));
          delete src.revision;
          return;
        }
        if (src.lines) {
          const [from, to] = src.lines;
          const total = blobLines(gitRoot, revision, gitPath);
          if (from > to || total < 0 || to > total) {
            allOk = false;
            diagnostics.push(warn('diagram/evidence-line-range', `${at}.lines`, `Lines ${from}–${to} of "${src.path}" are out of range (${total < 0 ? 'unreadable' : `${total} lines`}) at ${revision.slice(0, 12)}.`, ['narrow the line range', 'omit lines to cite the whole file']));
            delete src.revision;
            return;
          }
        }
        src.revision = revision;
      });
      el.evidence = allOk ? 'verified' : 'unverified';
      if (allOk) counts.verified++; else counts.unverified++;
    });
  }
  const url = readGitRemoteUrl(gitRoot);
  doc.meta.repository = { ...(url ? { url } : {}), revision };
  return finish(revision);
}
