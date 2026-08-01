import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';

type ResolveFilename = (
  request: string,
  parent?: unknown,
  isMain?: boolean,
  options?: unknown,
) => string;

type ModuleInternals = typeof Module & {
  _resolveFilename: ResolveFilename;
};

function redirectedPackedRequest(root: string, request: string): string | null {
  if (!path.isAbsolute(request)) return null;
  const marker = `${path.sep}app.asar${path.sep}node_modules${path.sep}`;
  const markerIndex = request.indexOf(marker);
  if (markerIndex < 0) return null;
  const relativeRequest = request.slice(markerIndex + marker.length);
  const candidate = path.resolve(root, relativeRequest);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(rootPrefix) && fs.existsSync(candidate) ? candidate : null;
}

/**
 * Electron utility processes can resolve an ESM entry from app.asar while the
 * CommonJS loader still tries to open that dependency inside the archive.
 * Redirect those already-resolved CommonJS entries to the builder's unpacked
 * dependency tree without changing normal package lookup.
 */
export function installUnpackedModuleResolution(root: string): () => void {
  if (!path.isAbsolute(root)) {
    throw new Error('Unpacked node_modules path must be absolute.');
  }

  const moduleInternals = Module as ModuleInternals;
  const original = moduleInternals._resolveFilename;

  function resolveFilename(
    this: ModuleInternals,
    request: string,
    parent?: unknown,
    isMain?: boolean,
    options?: unknown,
  ): string {
    const redirectedRequest = redirectedPackedRequest(root, request);
    if (redirectedRequest) return redirectedRequest;
    return original.call(this, request, parent, isMain, options);
  }

  moduleInternals._resolveFilename = resolveFilename;

  return () => {
    if (moduleInternals._resolveFilename === resolveFilename) {
      moduleInternals._resolveFilename = original;
    }
  };
}
