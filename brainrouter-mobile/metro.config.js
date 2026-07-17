// Metro config for brainrouter-mobile.
//
// This app lives inside a git worktree of the BrainRouter monorepo. It ships its
// OWN complete node_modules (React 19.1 / RN 0.81 / Expo 54) and is NOT a
// workspace member, so it resolves runtime modules from its own tree first. We
// keep Metro's default *hierarchical* node-module lookup ENABLED so packages that
// rely on a NESTED dependency resolve correctly (see the note at the bottom).
//
// The two pure @kinqs workspace packages it imports (agent-protocol, types) are
// bundled straight from their TypeScript SOURCE, so no `dist` build is required.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..'); // <worktree>/  (this app is <worktree>/brainrouter-mobile)

const config = getDefaultConfig(projectRoot);

// Resolve the pure @kinqs packages from source (RN-safe; zero runtime deps).
const kinqsSrc = {
  '@kinqs/brainrouter-agent-protocol': path.resolve(repoRoot, 'packages/agent-protocol/src/index.ts'),
  '@kinqs/brainrouter-types': path.resolve(repoRoot, 'packages/types/src/index.ts'),
};

// Metro must be allowed to read files outside the project root.
config.watchFolders = [
  path.resolve(repoRoot, 'packages/agent-protocol'),
  path.resolve(repoRoot, 'packages/types'),
];

const baseResolve = config.resolver.resolveRequest;
const defaultResolve = (context, name, platform) =>
  baseResolve ? baseResolve(context, name, platform) : context.resolveRequest(context, name, platform);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (kinqsSrc[moduleName]) {
    return { type: 'sourceFile', filePath: kinqsSrc[moduleName] };
  }
  // The ported domain layer uses ESM-style `.js` specifiers for sibling imports
  // (the tsx/node test runner requires them), but the files on disk are `.ts`.
  // Metro won't map `.js`→`.ts`, so for RELATIVE `.js` specifiers, try the
  // extensionless form first (which resolves the `.ts`); fall back if it misses.
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return defaultResolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // fall through to default resolution of the original specifier
    }
  }
  return defaultResolve(context, moduleName, platform);
};

// Prefer the app's own node_modules as the resolver root.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

// IMPORTANT: do NOT set `config.resolver.disableHierarchicalLookup = true`.
// Several deps `require()` a NESTED dependency that npm installed under their own
// node_modules. e.g. react-native-reanimated 4 requires `semver/functions/satisfies`
// from its bundled semver v7, while the hoisted top-level semver is v6 (flat
// layout, no `functions/` dir). Disabling the hierarchical walk hides the nested
// copy and breaks the bundle. The app ships its own react/react-native, so the
// default walk resolves those locally and never reaches the monorepo root.

module.exports = config;
