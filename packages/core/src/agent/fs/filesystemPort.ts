// ADR-041 D3 — Capability ports for the tool runtime.
//
// The builtin tool runtime does its filesystem side effects through this port
// instead of calling `node:fs` inline, so an execution world (ADR-041 D10) can
// swap where those effects land — a container, a remote box — without forking
// every tool. This is the same injection idiom the runtime already uses for
// `computerUsePort` / `browserControlPort`: an optional field on the Agent,
// defaulted to the local implementation when unset.
//
// The default `nodeFilesystemPort` wraps the exact `node:fs` calls the runtime
// made before, so wiring a tool onto the port is byte-identical behaviour: the
// interface is async (a remote world cannot be synchronous), but the local
// implementation performs the same synchronous `fs.*` operation under the hood,
// so there is no new interleaving on the local path.

import fs from "node:fs";

/** Minimal stat surface the tool runtime needs — never the full `fs.Stats`. */
export interface FilesystemStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * The filesystem capability the builtin tool runtime depends on. Every method is
 * async so an execution world can back it with remote or container I/O; the
 * default local implementation resolves synchronously.
 */
export interface FilesystemPort {
  /** True if a path exists (wraps `fs.existsSync`). */
  exists(path: string): Promise<boolean>;
  /** Stat a path; rejects if it does not exist (wraps `fs.statSync`). */
  stat(path: string): Promise<FilesystemStat>;
  /** Read a whole file as utf8 (wraps `fs.readFileSync(path, 'utf8')`). */
  readFile(path: string): Promise<string>;
  /**
   * Read at most `maxBytes` of a file as utf8, reporting whether the file was
   * larger than the cap. Bounds memory for large files (wraps the runtime's
   * open/read/close fast path).
   */
  readFileBounded(
    path: string,
    maxBytes: number,
  ): Promise<{ content: string; truncated: boolean }>;
  /** Write a utf8 file (wraps `fs.writeFileSync(path, content, 'utf8')`). */
  writeFile(path: string, content: string): Promise<void>;
  /** List a directory's entry names (wraps `fs.readdirSync`). */
  readDir(path: string): Promise<string[]>;
  /** Create a directory and any missing parents (wraps `fs.mkdirSync(recursive)`). */
  mkdirp(path: string): Promise<void>;
  /** Canonicalize a path, resolving symlinks (wraps `fs.realpathSync`). */
  realpath(path: string): Promise<string>;
}

/**
 * The default, local filesystem port. Each method performs the identical
 * `node:fs` synchronous operation the runtime called before D3, wrapped in a
 * resolved promise — so a tool migrated onto the port keeps byte-identical
 * behaviour on the local path.
 */
export const nodeFilesystemPort: FilesystemPort = {
  async exists(p) {
    return fs.existsSync(p);
  },
  async stat(p) {
    const s = fs.statSync(p);
    return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
  },
  async readFile(p) {
    return fs.readFileSync(p, "utf8");
  },
  async readFileBounded(p, maxBytes) {
    if (fs.statSync(p).size <= maxBytes) {
      return { content: fs.readFileSync(p, "utf8"), truncated: false };
    }
    const fd = fs.openSync(p, "r");
    try {
      const b = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, b, 0, maxBytes, 0);
      return { content: b.subarray(0, n).toString("utf8"), truncated: true };
    } finally {
      fs.closeSync(fd);
    }
  },
  async writeFile(p, content) {
    fs.writeFileSync(p, content, "utf8");
  },
  async readDir(p) {
    return fs.readdirSync(p);
  },
  async mkdirp(p) {
    fs.mkdirSync(p, { recursive: true });
  },
  async realpath(p) {
    return fs.realpathSync(p);
  },
};
