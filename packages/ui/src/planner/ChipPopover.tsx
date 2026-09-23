/**
 * ADR-038 — one popover behaviour for every control that opens one.
 *
 * Its own module because both the row's chips and the calendar's "Add calendar"
 * control need it, and `PlannerSurface` imports `PlannerCalendar` — putting it
 * in either would be a cycle, and copying it would be two popovers that close
 * on different keys.
 */
import { useRef } from 'react';
import type { FocusEvent, ReactElement, ReactNode } from 'react';

export function ChipPopover({ label, open, onOpen, className, children }: {
  label: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  className: string;
  children: ReactNode;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const leave = (event: FocusEvent<HTMLDivElement>): void => {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) onOpen(false);
  };
  return (
    <div
      ref={rootRef}
      className={`br-planner-chip${open ? ' is-open' : ''}`}
      onBlur={leave}
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); onOpen(false); } }}
    >
      {label}
      {open ? <div className={`br-planner-popover ${className}`} role="group">{children}</div> : null}
    </div>
  );
}
