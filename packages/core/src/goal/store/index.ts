// Goal store concern: the on-disk CRUD + lifecycle transitions for a Goal
// (goalStore), plus the per-workspace GoalService facade over it (service).
// goalStore additionally re-exports the model/budget/prompt surface so the
// long-standing `goal/goalStore.js` import path stays whole after the split.
export * from './goalStore.js';
export * from './service.js';
