/**
 * Internal picker primitive — purpose-built for the wizard / `/config` /
 * `/login` flows.
 *
 * This module is a thin re-export barrel. The implementation lives in
 * cohesive sibling modules under `./picker/`:
 *
 *   - `picker/types.ts`         — public option/result types + PickerRow
 *   - `picker/frame-render.ts`  — pure frame renderer + text helpers
 *   - `picker/frame-runtime.ts` — stdin / cursor / atomic-redraw runtime
 *   - `picker/pick-from-list.ts`— the list picker (with optional "Other")
 *   - `picker/prompt-text.ts`   — free-text / masked entry
 *
 * See `picker/types.ts` for the full render-contract documentation.
 */

// --- Public types ------------------------------------------------------

export type {
  PickerRow,
  PickFromListOptions,
  PickFromListResult,
  PromptTextOptions,
  PromptTextResult,
} from './picker/types.js';

// --- Frame renderer ----------------------------------------------------

export { renderFrame } from './picker/frame-render.js';

// --- Frame runtime -----------------------------------------------------

export { isInternalPickerActive } from './picker/frame-runtime.js';
export type { FramedInputOptions } from './picker/frame-runtime.js';

// --- Pickers -----------------------------------------------------------

export { pickFromList } from './picker/pick-from-list.js';
export { promptText } from './picker/prompt-text.js';

// --- Surface re-exports for tests + callers ---------------------------

import { renderFrame, formatBodyRow, visibleLength, stripAnsi, wrap, padRightVisible } from './picker/frame-render.js';
import { computeValueColumn, defaultFooter } from './picker/pick-from-list.js';

/** Pure helpers exposed for unit tests. */
export const __test = {
  renderFrame,
  formatBodyRow,
  visibleLength,
  stripAnsi,
  wrap,
  padRightVisible,
  computeValueColumn,
  defaultFooter,
};
