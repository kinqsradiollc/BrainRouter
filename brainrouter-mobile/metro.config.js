// Metro config for the BrainRouter monorepo.
// brainrouter-mobile lives inside the monorepo; dependencies (incl. the
// `@kinqs/*` workspace symlinks) are hoisted to the repo-root node_modules.
// We watch the repo root and let Metro resolve modules from both locations.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
// Repo root: .claude/worktrees/<name>/brainrouter-mobile -> up 4 levels.
const workspaceRoot = path.resolve(projectRoot, '../../../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Don't let Metro walk up past the project for the default resolution.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
