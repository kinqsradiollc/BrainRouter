/** Monotonic row-id generator for chat rows / tool items (renderer-local). */
let nextId = 0;
export const rid = (): number => ++nextId;
