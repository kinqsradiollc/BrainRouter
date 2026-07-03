// Public entrypoint for the desktop `components` folder. Grouped into per-concern
// subfolders (primitives / chat / model / dialogs / layout / status); this barrel
// re-exports each group's public surface so consumers can import from the folder
// root while the internal file layout stays an implementation detail.
export * from './primitives/index.js';
export * from './chat/index.js';
export * from './model/index.js';
export * from './dialogs/index.js';
export * from './layout/index.js';
export * from './status/index.js';
