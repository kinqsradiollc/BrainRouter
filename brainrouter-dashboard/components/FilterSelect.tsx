"use client";

/**
 * Compact themed dropdown for filters with many options (memory types,
 * operation kinds, …). Replaces long wrapping pill rows that dominate the
 * page. Native <select> for accessibility + zero extra deps.
 *
 * `value` "" = the "all" option. `options` are {value,label} pairs.
 */

export interface FilterSelectOption {
  value: string;
  label: string;
}

export function FilterSelect({
  value,
  onChange,
  options,
  allLabel = "All",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: FilterSelectOption[];
  allLabel?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        appearance: "none",
        WebkitAppearance: "none",
        background:
          "var(--overlay-bg) url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M3 4.5L6 7.5L9 4.5' stroke='%23999' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>\") no-repeat right 10px center",
        color: "var(--color-white-frost)",
        border: "1px solid var(--border-med)",
        borderRadius: "8px",
        padding: "6px 28px 6px 10px",
        fontSize: "13px",
        cursor: "pointer",
        minWidth: "160px",
        maxWidth: "220px",
      }}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
