// Barrel for the `delegation` concern — delegation-policy gating
// (`delegationPolicy`), auto follow-up chaining (`autoChain`), file-ownership
// enforcement for parallel writers (`ownership`), and the parent execution
// context snapshot passed down to children (`parentContext`).
export * from './delegationPolicy.js';
export * from './autoChain.js';
export * from './ownership.js';
export * from './parentContext.js';
