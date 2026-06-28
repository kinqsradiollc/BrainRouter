/**
 * A Claude-style draggable EFFORT slider (Faster → Smarter) for the composer's
 * reasoning popup. The stops are the active model's family profile options
 * (graded Low/Med/High[/Extra high] or binary Off/On), so dragging snaps between
 * the levels that model actually supports. Drag (or click / arrow keys) the knob;
 * the pick commits on release. Inline-styled with theme CSS variables only — no
 * theme.css changes.
 */
import React from 'react';
import type { ReasoningProfile, EffortLevel } from '../lib/models/reasoningProfile.js';
import { sliderIndexForEffort, effortAtSliderFraction } from '../lib/models/reasoningProfile.js';

interface Props {
  profile: ReasoningProfile;
  /** The active effort (session value), one of low|medium|high|xhigh. */
  effort: string;
  /** Commit a new level (dispatches set-session-mode upstream). */
  onPick: (level: EffortLevel) => void;
}

const INSET = 10;    // px — inset so the pill knob never clips the panel edge.
const TRACK_H = 15;  // px — the thick rounded track (Claude-Code reference look).
const KNOB_W = 14;   // px — white rounded-square knob width (matches the reference handle).
const KNOB_H = 18;   // px — knob height (a touch taller than the 15px bar).

// Injected once via a <style> inside the popup. Animates ONLY opacity (GPU-safe).
// The trough opacity + duration ride on inline CSS vars / longhand props, so this
// keyframe DECLARATION stays byte-constant across renders and the running pulse is
// retargeted (not torn down + restarted) while dragging. The reduced-motion rule
// is source-ordered after theme.css, so it pins a clean STILL state.
const RSL_KEYFRAMES = `
@keyframes rsl-twinkle {
  0%, 100% { opacity: var(--rsl-lo, 0.82); }
  50%      { opacity: 1; }
}
@keyframes rsl-sweep {
  0%   { background-position: -55% 0; opacity: 0; }
  14%  { opacity: var(--rsl-sweep-peak, 0.46); }
  44%  { opacity: var(--rsl-sweep-peak, 0.46); }
  55%  { background-position: 155% 0; opacity: 0; }
  100% { background-position: 155% 0; opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .rsl-twinkle { animation: none !important; opacity: 1 !important; }
  .rsl-sweep   { animation: none !important; background-position: 50% 0 !important; opacity: var(--rsl-sweep-still, 0.30) !important; }
}`;

export function ReasoningSlider({ profile, effort, onPick }: Props): React.ReactElement {
  const opts = profile.options;
  const count = opts.length;
  const railRef = React.useRef<HTMLDivElement | null>(null);
  // While dragging (or awaiting the ~prop round-trip) the knob follows this
  // local index; otherwise it derives from the committed `effort`.
  const [previewIdx, setPreviewIdx] = React.useState<number | null>(null);
  const baseIdx = sliderIndexForEffort(profile, effort);
  const idx = previewIdx ?? baseIdx;

  // Once the committed effort catches up to the preview, drop the local override.
  React.useEffect(() => {
    if (previewIdx !== null && opts[previewIdx] && opts[previewIdx].level === effort) {
      setPreviewIdx(null);
    }
  }, [effort, previewIdx, opts]);

  const indexFromClientX = (clientX: number): number => {
    const el = railRef.current;
    if (!el) return idx;
    const r = el.getBoundingClientRect();
    const usable = r.width - INSET * 2;
    const frac = usable > 0 ? (clientX - r.left - INSET) / usable : 0;
    const level = effortAtSliderFraction(profile, frac);
    const i = level ? opts.findIndex((o) => o.level === level) : idx;
    return i < 0 ? idx : i;
  };

  const commit = (i: number): void => {
    const lvl = opts[i] && opts[i].level;
    if (lvl && lvl !== opts[baseIdx]?.level) onPick(lvl);
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    try { railRef.current?.setPointerCapture(e.pointerId); } catch { /* pointer not active */ }
    setPreviewIdx(indexFromClientX(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    if (previewIdx === null) return;
    const i = indexFromClientX(e.clientX);
    if (i !== previewIdx) setPreviewIdx(i);
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    // Commit the RELEASE position (authoritative) rather than the last move state —
    // robust to a fast click where the move handler never fired.
    const i = indexFromClientX(e.clientX);
    try { railRef.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    setPreviewIdx(i);
    commit(i);
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    let next = baseIdx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(count - 1, baseIdx + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, baseIdx - 1);
    else return;
    e.preventDefault();
    if (next !== baseIdx) { setPreviewIdx(next); onPick(opts[next].level); }
  };

  const frac = count > 1 ? idx / (count - 1) : 0;
  const stopLeft = (i: number): string => `calc(${INSET}px + ${count > 1 ? i / (count - 1) : 0} * (100% - ${INSET * 2}px))`;

  // §reasoning-slider-animation — one normalized driver t (0 at Low … 1 at the
  // top stop = Max/Ultracode) escalates the fill's dot-shimmer + the knob glow.
  // Low (and a binary "Off") stay perfectly still; motion is gated off there and
  // under prefers-reduced-motion (the static dot density + ring remain as cues).
  const t = count > 1 ? idx / (count - 1) : 0;
  const dotPct = Math.round(40 + 45 * t);                              // dot color: 40% … 85% of --accent
  const twLo = (0.86 - 0.40 * t).toFixed(3);                           // pulse trough: 0.86 (calm) … 0.46 (lively)
  const twDur = `${(2.9 - 1.6 * t).toFixed(2)}s`;                      // pulse speed: 2.9s … 1.3s
  const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = idx >= 1 && frac > 0 && !reduceMotion;
  // §top-tier signature — the highest stop of a GRADED model with 3+ stops
  // (Extra high / Max / Ultracode). Excludes binary On/Off and always-on/none.
  const isTop = profile.kind === 'graded' && count >= 3 && idx === count - 1;
  const sweepOn = isTop && animate;
  // A static "maxed" cue so the bar reads densest/brightest even between sweeps.
  const dotMaxPct = isTop ? 90 : dotPct;
  const fillPct = isTop ? 32 : 26;

  return (
    <div style={{ padding: '8px 11px 9px', minWidth: 188 }}>
      <style>{RSL_KEYFRAMES}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
        <span style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.6 }}>Effort </span>
          <b style={{ color: isTop ? 'var(--accent)' : 'var(--text)' }}>{opts[idx]?.label ?? ''}</b>
        </span>
        <span
          title="Higher effort = more reasoning before answering (slower). Fast mode forces the minimum."
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15,
            borderRadius: '50%', border: '1px solid var(--border-strong)', color: 'var(--text-dim)',
            fontSize: 10, lineHeight: 1, cursor: 'help', userSelect: 'none',
          }}
        >?</span>
      </div>
      <div
        ref={railRef}
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={idx}
        aria-valuetext={opts[idx]?.label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        style={{ position: 'relative', height: 22, cursor: 'pointer', touchAction: 'none', userSelect: 'none' }}
      >
        {/* track — a thick rounded bar; the FILLED portion carries the dotted
            accent shimmer; a white pill knob rides above it (Claude-Code look).
            The drag target is this wrapper (railRef); inner layers are inert. */}
        <div
          style={{
            position: 'absolute', top: '50%', left: INSET, right: INSET, height: TRACK_H,
            borderRadius: TRACK_H / 2, transform: 'translateY(-50%)', overflow: 'hidden',
            background: 'var(--border-strong)', pointerEvents: 'none',
          }}
        >
          {/* filled base — NEUTRAL grey up to the knob at every tier; only the
              TOP tier lights up to the accent wash (per spec: colour at the summit). */}
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `calc(${frac} * 100%)`, background: isTop ? `color-mix(in srgb, var(--accent) ${fillPct}%, transparent)` : 'color-mix(in srgb, var(--text) 30%, transparent)' }} />
          {/* dotted shimmer — a tiled accent dot GRID whose opacity breathes.
              ONLY at the top tier; below, the bar stays a clean neutral fill.
              Decorative (pointerEvents:none). */}
          {isTop ? (
            <div
              className="rsl-twinkle"
              aria-hidden
              style={{
                position: 'absolute', top: 0, bottom: 0, left: 0, width: `calc(${frac} * 100%)`, pointerEvents: 'none',
                backgroundImage: `radial-gradient(circle at 1.6px 1.6px, color-mix(in srgb, var(--accent) ${dotMaxPct}%, transparent) 1px, transparent 1.5px)`,
                backgroundSize: '4.5px 4.5px', backgroundRepeat: 'repeat',
                ['--rsl-lo' as keyof React.CSSProperties]: twLo,
                animationName: animate ? 'rsl-twinkle' : 'none',
                animationDuration: twDur, animationTimingFunction: 'ease-in-out', animationIterationCount: 'infinite',
                opacity: 1, willChange: animate ? 'opacity' : 'auto',
              } as React.CSSProperties}
            />
          ) : null}
          {/* §top-tier signature — a specular accent band sweeps the whole bar
              ONLY at the highest stop (Extra high / Max / Ultracode). Clipped by
              the track's overflow:hidden; pointerEvents:none so it never blocks the
              drag. Under reduced-motion the @media rule pins a static crease. */}
          {isTop ? (
            <div
              className="rsl-sweep"
              aria-hidden
              style={{
                position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, pointerEvents: 'none',
                backgroundImage:
                  'linear-gradient(100deg, transparent 42%, '
                  + 'color-mix(in srgb, var(--accent) 72%, transparent) 48%, '
                  + 'color-mix(in srgb, var(--accent) 90%, var(--text)) 50%, '
                  + 'color-mix(in srgb, var(--accent) 72%, transparent) 52%, '
                  + 'transparent 58%)',
                backgroundSize: '230% 100%', backgroundRepeat: 'no-repeat', backgroundPosition: '-55% 0',
                ['--rsl-sweep-peak' as keyof React.CSSProperties]: 0.46,
                ['--rsl-sweep-still' as keyof React.CSSProperties]: 0.3,
                animationName: sweepOn ? 'rsl-sweep' : 'none',
                animationDuration: '3s', animationTimingFunction: 'ease-in-out', animationIterationCount: 'infinite',
                opacity: sweepOn ? undefined : 0,
                willChange: sweepOn ? 'background-position, opacity' : 'auto',
              } as React.CSSProperties}
            />
          ) : null}
        </div>
        {/* level stop dots — small neutral markers so the tiers are visible. One
            coordinated soft grey for ALL of them (no purple cue): colour is
            reserved for the top tier, where the whole bar lights up. */}
        {opts.map((o, i) => (
          <div
            key={o.level}
            aria-hidden
            style={{
              position: 'absolute', top: '50%', left: stopLeft(i), width: 3, height: 3, borderRadius: '50%',
              transform: 'translate(-50%, -50%)', pointerEvents: 'none',
              background: 'color-mix(in srgb, var(--text) 50%, transparent)',
            }}
          />
        ))}
        {/* knob — white rounded pill, above the track (taller than the bar) */}
        <div
          style={{
            position: 'absolute', top: '50%', left: stopLeft(idx), width: KNOB_W, height: KNOB_H,
            borderRadius: 6, transform: 'translate(-50%, -50%)', background: 'var(--text)',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.45)', pointerEvents: 'none',
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontSize: 11, opacity: 0.55 }}>
        <span>{profile.kind === 'binary' ? 'Off' : 'Faster'}</span>
        <span>{profile.kind === 'binary' ? 'On' : 'Smarter'}</span>
      </div>
    </div>
  );
}
