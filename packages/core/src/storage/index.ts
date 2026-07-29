// Public entrypoint for the `storage` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/storage` instead of deep `dist/storage/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './checkpointStore.js';
export * from './fileSnapshotStore.js';
export * from './store.js';
export * from './contracts.js';
export * from './policy/index.js';
export type { StoragePersistencePort } from './ports/index.js';
export {
  StorageService,
  createStorageService,
  type IStorageService,
} from './service.js';
