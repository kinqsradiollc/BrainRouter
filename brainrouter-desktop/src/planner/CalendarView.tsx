/**
 * ADR-028 G6 — the calendar, as a real time grid.
 *
 * The first version was seven boxes with text in them, which is a list wearing
 * a calendar's layout: it could not show when something starts, how long it
 * runs, or that two things collide. Those three facts are the entire reason to
 * draw a calendar rather than print a list.
 *
 * So: hours down the gutter, days across, blocks positioned and sized by time,
 * overlapping blocks side by side, and a line showing where you are now.
 *
 * All the positioning maths lives in `plannerView` and is unit-tested. This
 * file places what it is told to place.
 */
import React, { useMemo } from 'react';
import { Icon } from '../icons.js';
import {
  weekView, weekStart, shiftWeek, layOutDay, hourLabels, nowMarkerPct,
  dayHeading, unscheduledBlocks, DAY_START_HOUR, DAY_END_HOUR,
  type PlannerBlockView,
} from '../lib/planner/plannerView.js';

const HOURS = hourLabels();

export function CalendarView({
  blocks, today, titleFor, weekOf, onWeek, onCreateAt, onOpenBlock,
}: {
  blocks: PlannerBlockView[];
  today: string;
  titleFor: Record<string, string>;
  /** The Monday being shown. */
  weekOf: string;
  onWeek: (startDate: string) => void;
  /** Click an empty slot to block time there — the primary calendar gesture. */
  onCreateAt: (iso: string) => void;
  onOpenBlock: (blockId: string) => void;
}): React.ReactElement {
  const days = useMemo(() => weekView(blocks, weekOf, today), [blocks, weekOf, today]);
  const loose = useMemo(() => unscheduledBlocks(blocks), [blocks]);
  const nowPct = nowMarkerPct(new Date());
  const thisWeek = weekOf === weekStart(today);

  return (
    <div className="cal">
      <header className="cal-bar">
        <div className="cal-nav">
          <button className="cal-nav-btn" aria-label="Previous week" onClick={() => onWeek(shiftWeek(weekOf, -1))}>‹</button>
          <button className="cal-today" onClick={() => onWeek(weekStart(today))} disabled={thisWeek}>Today</button>
          <button className="cal-nav-btn" aria-label="Next week" onClick={() => onWeek(shiftWeek(weekOf, 1))}>›</button>
        </div>
        <span className="cal-range">{monthLabel(days[0]!.date, days[6]!.date)}</span>
      </header>

      {loose.length > 0 ? (
        // The all-day row's honest equivalent: work you committed to without
        // committing to a time. A today list is a real plan (D5), so it sits
        // ABOVE the grid rather than being hidden by it.
        <div className="cal-unscheduled">
          <span className="cal-gutter-label">no time</span>
          <div className="cal-unscheduled-items">
            {loose.map((b) => (
              <button key={b.id} className="cal-chip" onClick={() => onOpenBlock(b.id)}>
                {titleFor[b.itemId] ?? b.itemId}
                <span className="cal-chip-est">{b.estimateMinutes}m</span>
                {b.carriedOver > 2 ? <span className="cal-chip-moved">moved {b.carriedOver}×</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="cal-head">
        <span className="cal-gutter" />
        {days.map((day) => {
          const { weekday, day: num } = dayHeading(day.date);
          return (
            <div key={day.date} className={`cal-head-day${day.isToday ? ' today' : ''}`}>
              <span className="cal-weekday">{weekday}</span>
              <span className="cal-daynum">{num}</span>
              {day.plannedMinutes > 0 ? (
                <span className="cal-day-total">{Math.round(day.plannedMinutes / 6) / 10}h</span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="cal-grid">
        <div className="cal-gutter">
          {HOURS.map((h) => (
            <div key={h.hour} className="cal-hour-label"><span>{h.label}</span></div>
          ))}
        </div>

        {days.map((day) => (
          <div key={day.date} className={`cal-col${day.isToday ? ' today' : ''}`}>
            {/* Hour lines double as click targets: clicking 2pm on Wednesday
                blocks time at 2pm on Wednesday, which is the gesture people
                already have in their fingers from every other calendar. */}
            {HOURS.slice(0, -1).map((h) => (
              <button
                key={h.hour}
                className="cal-slot"
                style={{ top: `${((h.hour - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100}%` }}
                aria-label={`Block time at ${h.label} on ${day.date}`}
                onClick={() => onCreateAt(`${day.date}T${String(h.hour).padStart(2, '0')}:00:00`)}
              />
            ))}

            {layOutDay(day.blocks).map(({ block, topPct, heightPct, lane, lanes }) => (
              <button
                key={block.id}
                className={`cal-event${block.completedAt ? ' done' : ''}`}
                style={{
                  top: `${topPct}%`,
                  height: `${heightPct}%`,
                  left: `${(lane / lanes) * 100}%`,
                  width: `${(1 / lanes) * 100}%`,
                }}
                onClick={() => onOpenBlock(block.id)}
                title={titleFor[block.itemId] ?? block.itemId}
              >
                <span className="cal-event-title">{titleFor[block.itemId] ?? block.itemId}</span>
                <span className="cal-event-time">
                  {clockOf(block.scheduledFor!)}
                  {/* Planned against actual, inline — the gap is the useful
                      information and it belongs where you look, not in a report. */}
                  {block.actualMinutes
                    ? ` · ${block.estimateMinutes}→${block.actualMinutes}m`
                    : ` · ${block.estimateMinutes}m`}
                </span>
              </button>
            ))}

            {day.isToday && nowPct !== null ? (
              <div className="cal-now" style={{ top: `${nowPct}%` }} aria-hidden="true">
                <span className="cal-now-dot" />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {days.every((d) => d.blocks.length === 0) && loose.length === 0 ? (
        <div className="cal-empty">
          <Icon name="chart" size={14} />
          <span>Click any hour to block time. Blocks record what you planned against what it took.</span>
        </div>
      ) : null}
    </div>
  );
}

function clockOf(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${display}${suffix}` : `${display}:${String(m).padStart(2, '0')}${suffix}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `4–10 Aug` · `28 Jul – 3 Aug` — the range, without repeating the month. */
function monthLabel(from: string, to: string): string {
  const a = new Date(`${from}T00:00:00.000Z`);
  const b = new Date(`${to}T00:00:00.000Z`);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  return sameMonth
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${b.getUTCFullYear()}`
    : `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}
