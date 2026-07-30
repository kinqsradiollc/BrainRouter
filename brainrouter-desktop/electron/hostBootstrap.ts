import { installUnpackedModuleResolution } from './hostModuleResolution.js';

const unpackedNodeModules = process.env.BRAINROUTER_DESKTOP_UNPACKED_NODE_MODULES;
if (unpackedNodeModules) {
  installUnpackedModuleResolution(unpackedNodeModules);
}

await import('./host.js');
