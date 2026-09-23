/**
 * ADR-052 P4.5 — apply an org-curated overlay (`cli.modelPicker`) OVER the live
 * `/v1/models` result: pinned entries float to the top, then the declared order,
 * then everything else in its original order; a `label` renames a row for
 * display. Presentation only — an overlay id that the endpoint did NOT return is
 * dropped, so the endpoint stays the source of truth for what exists.
 */
export interface ModelPickerEntry { id: string; label?: string; pinned?: boolean }
export interface PickerModel { id: string; label: string }

export function applyModelPickerOverlay(models: readonly string[], overlay: readonly ModelPickerEntry[]): PickerModel[] {
  if (!overlay || overlay.length === 0) return models.map((id) => ({ id, label: id }));

  const present = new Set(models);
  const overlayIds = new Set(overlay.map((o) => o.id));
  const seen = new Set<string>();
  const out: PickerModel[] = [];

  const push = (id: string, label?: string): void => {
    if (seen.has(id) || !present.has(id)) return;
    seen.add(id);
    out.push({ id, label: label && label.trim() ? label : id });
  };

  // 1) pinned overlay entries, in overlay order.
  for (const o of overlay) if (o.pinned) push(o.id, o.label);
  // 2) the rest of the overlay, in overlay order.
  for (const o of overlay) if (!o.pinned) push(o.id, o.label);
  // 3) everything the overlay didn't mention, in the endpoint's original order.
  for (const m of models) if (!overlayIds.has(m)) push(m);

  return out;
}
