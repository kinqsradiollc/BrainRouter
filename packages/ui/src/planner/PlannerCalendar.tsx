/**
 * ADR-038 — the shared Planner calendar presentation.
 * One roving tab stop covers the 98 hour cells so keyboard navigation remains
 * complete without making the rest of the page take 98 presses to reach.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent, ReactElement } from 'react';

import type { PlannerBlockView } from './types.js';
import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  dayHeading,
  hourLabels,
  keyboardBlockTime,
  layOutDay,
  nowMarkerPct,
  shiftWeek,
  unscheduledBlocks,
  weekStart,
  weekView,
} from './viewModel.js';

const HOURS = hourLabels();
const SLOT_HOURS = HOURS.slice(0, -1);

export interface PlannerCalendarProps {
  blocks: PlannerBlockView[];
  today: string;
  titleFor: Record<string, string>;
  weekOf: string;
  onWeek: (startDate: string) => void;
  onCreateAt?: (iso: string) => void;
  onRescheduleBlock?: (blockId: string, scheduledFor: string) => void;
  onRecordActual?: (blockId: string, actualMinutes: number) => void;
}

const BLOCK_DRAG_TYPE = 'application/x-brainrouter-planner-block';

export function PlannerCalendar({
  blocks,
  today,
  titleFor,
  weekOf,
  onWeek,
  onCreateAt,
  onRescheduleBlock,
  onRecordActual,
}: PlannerCalendarProps): ReactElement {
  const days = useMemo(() => weekView(blocks, weekOf, today), [blocks, weekOf, today]);
  const loose = useMemo(() => unscheduledBlocks(blocks), [blocks]);
  const nowPct = nowMarkerPct(new Date());
  const [activeSlot, setActiveSlot] = useState(0);
  const [dropSlot, setDropSlot] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const slotRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveSlot = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index;
    if (event.key === 'ArrowDown') next += 1;
    else if (event.key === 'ArrowUp') next -= 1;
    else if (event.key === 'ArrowRight') next += SLOT_HOURS.length;
    else if (event.key === 'ArrowLeft') next -= SLOT_HOURS.length;
    else if (event.key === 'Home') next = Math.floor(index / SLOT_HOURS.length) * SLOT_HOURS.length;
    else if (event.key === 'End') next = Math.floor(index / SLOT_HOURS.length) * SLOT_HOURS.length + SLOT_HOURS.length - 1;
    else return;
    event.preventDefault();
    next = Math.max(0, Math.min(days.length * SLOT_HOURS.length - 1, next));
    setActiveSlot(next);
    slotRefs.current[next]?.focus();
  };

  const startDrag = (event: DragEvent<HTMLButtonElement>, blockId: string): void => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(BLOCK_DRAG_TYPE, blockId);
    event.dataTransfer.setData('text/plain', blockId);
  };

  const allowDrop = (event: DragEvent<HTMLButtonElement>, slot: string): void => {
    if (!onRescheduleBlock || !event.dataTransfer.types.includes(BLOCK_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropSlot(slot);
  };

  const dropBlock = (event: DragEvent<HTMLButtonElement>, scheduledFor: string): void => {
    const blockId = event.dataTransfer.getData(BLOCK_DRAG_TYPE);
    setDropSlot(null);
    if (!onRescheduleBlock || !blockId) return;
    event.preventDefault();
    onRescheduleBlock(blockId, scheduledFor);
  };

  const moveBlock = (
    event: KeyboardEvent<HTMLButtonElement>,
    block: PlannerBlockView,
  ): void => {
    if (!event.altKey || !onRescheduleBlock || !block.scheduledFor) return;
    const scheduledFor = keyboardBlockTime(block.scheduledFor, event.key);
    if (!scheduledFor) return;
    event.preventDefault();
    onRescheduleBlock(block.id, scheduledFor);
  };

  return (
    <div className="br-planner-calendar">
      <header className="br-planner-calendar-bar">
        <div className="br-planner-calendar-nav">
          <button type="button" aria-label="Previous week" onClick={() => onWeek(shiftWeek(weekOf, -1))}>‹</button>
          <button type="button" onClick={() => onWeek(weekStart(today))} disabled={weekOf === weekStart(today)}>Today</button>
          <button type="button" aria-label="Next week" onClick={() => onWeek(shiftWeek(weekOf, 1))}>›</button>
        </div>
        <span className="br-planner-calendar-range">{monthLabel(days[0]!.date, days[6]!.date)}</span>
      </header>

      {loose.length > 0 ? (
        <div className="br-planner-unscheduled">
          <span className="br-planner-calendar-gutter-label">No time</span>
          <div className="br-planner-unscheduled-items">
            {loose.map((block) => (
              <button
                type="button"
                key={block.id}
                onClick={() => setSelectedBlockId(block.id)}
                draggable={Boolean(onRescheduleBlock)}
                onDragStart={(event) => startDrag(event, block.id)}
              >
                {titleFor[block.itemId] ?? block.itemId}
                <span>{block.estimateMinutes}m</span>
                {block.carriedOver > 2 ? <span>moved {block.carriedOver}×</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="br-planner-calendar-head">
        <span className="br-planner-calendar-gutter" />
        {days.map((day) => {
          const heading = dayHeading(day.date);
          return (
            <div key={day.date} className={day.isToday ? 'is-today' : ''}>
              <span>{heading.weekday}</span>
              <strong>{heading.day}</strong>
              {day.plannedMinutes ? <small>{Math.round(day.plannedMinutes / 6) / 10}h</small> : null}
            </div>
          );
        })}
      </div>

      <div className="br-planner-calendar-grid">
        <div className="br-planner-calendar-gutter">
          {HOURS.map((hour) => <div key={hour.hour}><span>{hour.label}</span></div>)}
        </div>
        {days.map((day, dayIndex) => (
          <div key={day.date} className={`br-planner-calendar-column${day.isToday ? ' is-today' : ''}`}>
            {SLOT_HOURS.map((hour, hourIndex) => {
              const index = dayIndex * SLOT_HOURS.length + hourIndex;
              const scheduledFor = localSlotInstant(day.date, hour.hour);
              return (
                <button
                  type="button"
                  key={hour.hour}
                  ref={(node) => { slotRefs.current[index] = node; }}
                  className={`br-planner-calendar-slot${dropSlot === scheduledFor ? ' is-drop-target' : ''}`}
                  style={{ top: `${((hour.hour - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100}%` }}
                  aria-label={`Block time at ${hour.label} on ${day.date}`}
                  tabIndex={index === activeSlot ? 0 : -1}
                  onFocus={() => setActiveSlot(index)}
                  onKeyDown={(event) => moveSlot(event, index)}
                  onClick={() => onCreateAt?.(scheduledFor)}
                  onDragEnter={(event) => allowDrop(event, scheduledFor)}
                  onDragOver={(event) => allowDrop(event, scheduledFor)}
                  onDragLeave={() => setDropSlot((current) => current === scheduledFor ? null : current)}
                  onDrop={(event) => dropBlock(event, scheduledFor)}
                  disabled={!onCreateAt && !onRescheduleBlock}
                />
              );
            })}
            {layOutDay(day.blocks).map(({ block, topPct, heightPct, lane, lanes }) => (
              <button
                type="button"
                key={block.id}
                data-block-id={block.id}
                className={`br-planner-calendar-event${block.completedAt ? ' is-done' : ''}`}
                style={{
                  top: `${topPct}%`,
                  height: `${heightPct}%`,
                  left: `${(lane / lanes) * 100}%`,
                  width: `${(1 / lanes) * 100}%`,
                }}
                onClick={() => setSelectedBlockId(block.id)}
                draggable={Boolean(onRescheduleBlock && !block.completedAt)}
                onDragStart={(event) => startDrag(event, block.id)}
                onKeyDown={(event) => moveBlock(event, block)}
                aria-keyshortcuts={onRescheduleBlock ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : undefined}
                aria-label={`${titleFor[block.itemId] ?? block.itemId}, ${clockOf(block.scheduledFor!)} for ${block.estimateMinutes} minutes${onRescheduleBlock ? '. Hold Alt and use arrow keys to move by an hour or a day.' : ''}`}
                title={`${titleFor[block.itemId] ?? block.itemId}${onRescheduleBlock ? ' · Drag to move; Alt+arrow keys also move it' : ''}`}
              >
                <span>{titleFor[block.itemId] ?? block.itemId}</span>
                <small>{clockOf(block.scheduledFor!)} · {block.estimateMinutes}m</small>
              </button>
            ))}
            {day.isToday && nowPct !== null ? <div className="br-planner-calendar-now" style={{ top: `${nowPct}%` }} /> : null}
          </div>
        ))}
      </div>

      {days.every((day) => day.blocks.length === 0) && loose.length === 0 ? (
        <div className="br-planner-empty br-planner-calendar-empty">
          <strong>No time blocked this week</strong>
          <span>Choose an hour to make room for work; estimates become useful once actual time is recorded.</span>
        </div>
      ) : null}
      {selectedBlockId ? (
        <BlockDetails
          key={selectedBlockId}
          block={blocks.find((block) => block.id === selectedBlockId)}
          title={titleFor[blocks.find((block) => block.id === selectedBlockId)?.itemId ?? '']}
          onClose={() => setSelectedBlockId(null)}
          onRecordActual={onRecordActual}
        />
      ) : null}
    </div>
  );
}

function BlockDetails({ block, title, onClose, onRecordActual }: {
  block: PlannerBlockView | undefined;
  title: string | undefined;
  onClose: () => void;
  onRecordActual?: (blockId: string, actualMinutes: number) => void;
}): ReactElement | null {
  const [actual, setActual] = useState(String(block?.actualMinutes ?? block?.estimateMinutes ?? 0));
  const [actualDirty, setActualDirty] = useState(false);
  const actualInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const returnFocusTo = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    actualInputRef.current?.focus();
    return () => returnFocusTo?.focus();
  }, []);
  useEffect(() => {
    if (!actualDirty) {
      setActual(String(block?.actualMinutes ?? block?.estimateMinutes ?? 0));
    }
  }, [actualDirty, block?.actualMinutes, block?.estimateMinutes]);
  if (!block) return null;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const minutes = Number(actual);
    if (!onRecordActual || !Number.isFinite(minutes) || minutes < 0) return;
    onRecordActual(block.id, minutes);
    onClose();
  };
  return (
    <div
      className="br-planner-block-details"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`planner-block-${block.id}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <form onSubmit={submit}>
        <strong id={`planner-block-${block.id}`}>{title ?? block.itemId}</strong>
        <span>Planned {block.estimateMinutes} minutes{block.scheduledFor ? ` at ${clockOf(block.scheduledFor)}` : ''}</span>
        <label>
          Actual minutes
          <input
            ref={actualInputRef}
            type="number"
            min="0"
            step="1"
            value={actual}
            onChange={(event) => {
              setActualDirty(true);
              setActual(event.target.value);
            }}
            disabled={!onRecordActual}
          />
        </label>
        <div>
          <button type="button" onClick={onClose}>Close</button>
          {onRecordActual ? <button type="submit">Save actual time</button> : null}
        </div>
      </form>
    </div>
  );
}

/** Convert a wall-clock calendar slot into an unambiguous UTC instant. */
export function localSlotInstant(date: string, hour: number): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('A calendar slot needs a valid local date and hour.');
  }
  return new Date(year, month - 1, day, hour, 0, 0, 0).toISOString();
}

function clockOf(iso: string): string {
  const value = new Date(iso);
  const hour = value.getHours();
  const minute = value.getMinutes();
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0
    ? `${display}${hour < 12 ? 'am' : 'pm'}`
    : `${display}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(from: string, to: string): string {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS[start.getUTCMonth()]} ${end.getUTCFullYear()}`
    : `${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}
