/**
 * ADR-038 — compatibility export for callers that still name Desktop's former
 * calendar module. The presentation and its keyboard model now live in UI.
 */
export { PlannerCalendar as CalendarView } from '@kinqs/brainrouter-ui/planner';
export type { PlannerCalendarProps as CalendarViewProps } from '@kinqs/brainrouter-ui/planner';
