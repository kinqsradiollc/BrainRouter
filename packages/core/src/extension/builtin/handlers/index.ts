// ADR-041 D8 — builtin tool handlers. This barrel registers every migrated tool's
// handler and re-exports the dispatch API the runtime switch consults. Each
// migration slice adds one handler module + one line to the registration list.
import { registerBuiltinHandler } from './registry.js';
import { plannerHandlers } from './planner.js';
import { readOnlyHandlers } from './readOnly.js';
import { mcpHandlers } from './mcp.js';
import { trackHandlers } from './track.js';
import { workerHandlers } from './worker.js';

// Registration runs once, when this module is first imported (by runtime.ts).
for (const [name, handler] of Object.entries({ ...plannerHandlers, ...readOnlyHandlers, ...mcpHandlers, ...trackHandlers, ...workerHandlers })) {
  registerBuiltinHandler(name, handler);
}

export {
  builtinToolHandler,
  registeredHandlerNames,
  type BuiltinToolContext,
  type BuiltinToolHandler,
  type BuiltinToolHost,
} from './registry.js';
