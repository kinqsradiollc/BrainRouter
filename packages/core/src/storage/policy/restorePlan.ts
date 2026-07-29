import type { FileMutationRecord, RestoreAction } from '../contracts.js';

/**
 * Plan a restore to the end of `turnN` without reading or writing the host.
 * Each file returns to its state before its earliest mutation after that turn.
 */
export function planRestore(
  records: FileMutationRecord[],
  turnN: number,
): RestoreAction[] {
  const earliestPostN = new Map<string, FileMutationRecord>();
  for (const record of records) {
    if (record.turn <= turnN) continue;
    const existing = earliestPostN.get(record.path);
    if (!existing || record.turn < existing.turn) {
      earliestPostN.set(record.path, record);
    }
  }
  return [...earliestPostN.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((record) => record.priorContent === null
      ? { path: record.path, action: 'delete' as const }
      : { path: record.path, action: 'write' as const, content: record.priorContent });
}
