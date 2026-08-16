/**
 * Treat the presence of the reserved `metadata.learned` key as authoritative,
 * even when the value is malformed. Generic memory paths must fail closed for
 * projections owned by the hosted-learning lifecycle.
 */
export function hasLearnedMemoryMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const candidate = envelope.memory && typeof envelope.memory === "object" && !Array.isArray(envelope.memory)
    ? envelope.memory as Record<string, unknown>
    : envelope;
  const metadata = candidate.metadata;
  return !!metadata
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && Object.prototype.hasOwnProperty.call(metadata, "learned");
}
