/**
 * A Claude-style draggable EFFORT slider (Faster → Smarter) for the composer's
 * reasoning popup. The stops are the active model's family profile options
 * (graded Low/Med/High[/Extra high] or binary Off/On), so dragging snaps between
 * the levels that model actually supports. Drag (or click / arrow keys) the knob;
 * the pick commits on release.
 */
import React from 'react';
import type { ReasoningProfile, EffortLevel } from '../../lib/models/reasoningProfile.js';
import { sliderIndexForEffort, effortAtSliderFraction } from '../../lib/models/reasoningProfile.js';

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

const outerStyle: React.CSSProperties = { padding: '8px 11px 9px', minWidth: 188 };
const headerStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 };
const helpStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 15,
  height: 15,
  borderRadius: '50%',
  border: '1px solid var(--border-strong)',
  color: 'var(--text-dim)',
  fontSize: 10,
  lineHeight: 1,
  cursor: 'help',
  userSelect: 'none',
};
const railStyle: React.CSSProperties = { position: 'relative', height: 22, cursor: 'pointer', touchAction: 'none', userSelect: 'none' };
const labelRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', marginTop: 7, fontSize: 11, opacity: 0.55 };
const stopDotStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  width: 3,
  height: 3,
  borderRadius: '50%',
  transform: 'translate(-50%, -50%)',
  pointerEvents: 'none',
  background: 'color-mix(in srgb, var(--text) 50%, transparent)',
};

function usePrefersReducedMotion(): boolean {
  const [reduceMotion, setReduceMotion] = React.useState<boolean>(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduceMotion(media.matches);
    update();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return reduceMotion;
}

function ReasoningSliderComponent({ profile, effort, onPick }: Props): React.ReactElement {
  const opts = profile.options;
  const count = opts.length;
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const rectRef = React.useRef<DOMRect | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const latestClientXRef = React.useRef<number | null>(null);
  const draggingRef = React.useRef(false);
  const idxRef = React.useRef(0);
  // While dragging (or awaiting the ~prop round-trip) the knob follows this
  // local index; otherwise it derives from the committed `effort`.
  const [previewIdx, setPreviewIdx] = React.useState<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const baseIdx = sliderIndexForEffort(profile, effort);
  const idx = previewIdx ?? baseIdx;
  const reduceMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    idxRef.current = idx;
  }, [idx]);

  // Once the committed effort catches up to the preview, drop the local override.
  React.useEffect(() => {
    if (previewIdx !== null && opts[previewIdx] && opts[previewIdx].level === effort) {
      setPreviewIdx(null);
    }
  }, [effort, previewIdx, opts]);

  React.useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  const indexFromClientX = React.useCallback((clientX: number, rect = rectRef.current): number => {
    if (!rect) return idxRef.current;
    const usable = rect.width - INSET * 2;
    const frac = usable > 0 ? (clientX - rect.left - INSET) / usable : 0;
    const level = effortAtSliderFraction(profile, frac);
    const i = level ? opts.findIndex((o) => o.level === level) : idxRef.current;
    return i < 0 ? idxRef.current : i;
  }, [opts, profile]);

  const commit = React.useCallback((i: number): void => {
    const lvl = opts[i] && opts[i].level;
    if (lvl && lvl !== opts[baseIdx]?.level) onPick(lvl);
  }, [baseIdx, onPick, opts]);

  const flushPointerFrame = React.useCallback((): void => {
    rafRef.current = null;
    if (!draggingRef.current || latestClientXRef.current === null) return;
    const i = indexFromClientX(latestClientXRef.current);
    if (i !== idxRef.current) {
      idxRef.current = i;
      setPreviewIdx(i);
    }
  }, [indexFromClientX]);

  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    try { railRef.current?.setPointerCapture(e.pointerId); } catch { /* pointer not active */ }
    rectRef.current = railRef.current?.getBoundingClientRect() ?? null;
    draggingRef.current = true;
    setIsDragging(true);
    const i = indexFromClientX(e.clientX, rectRef.current);
    idxRef.current = i;
    setPreviewIdx(i);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!draggingRef.current) return;
    latestClientXRef.current = e.clientX;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flushPointerFrame);
    }
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    // Commit the RELEASE position (authoritative) rather than the last move state —
    // robust to a fast click where the move handler never fired.
    const i = indexFromClientX(e.clientX);
    try { railRef.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    draggingRef.current = false;
    rectRef.current = null;
    latestClientXRef.current = null;
    setIsDragging(false);
    idxRef.current = i;
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
  const stopLeft = React.useCallback((i: number): string => `calc(${INSET}px + ${count > 1 ? i / (count - 1) : 0} * (100% - ${INSET * 2}px))`, [count]);

  // §reasoning-slider-animation — one normalized driver t (0 at Low … 1 at the
  // top stop = Max/Ultracode) escalates the fill's dot-shimmer + the knob glow.
  // Two motion triggers, both compositor-only (opacity / transform — no layout):
  //   • SLIDE FEEDBACK — while you DRAG any stop above Low, the dotted shimmer
  //     plays so the slide feels alive; it escalates toward the top.
  //   • TOP-TIER SIGNATURE — the highest graded stop (Extra high / Max /
  //     Ultracode) animates ALWAYS (shimmer + a specular sweep), even at rest, as
  //     the "maxed reasoning" cue. prefers-reduced-motion pins everything static
  //     (the static dot density + accent fill + knob glow remain as cues).
  const t = count > 1 ? idx / (count - 1) : 0;
  const twLo = (0.86 - 0.40 * t).toFixed(3);                           // pulse trough: 0.86 (calm) … 0.46 (lively)
  const twDur = `${(2.9 - 1.6 * t).toFixed(2)}s`;                      // pulse speed: 2.9s … 1.3s
  // §top-tier signature — the highest stop of a GRADED model with 3+ stops
  // (Extra high / Max / Ultracode). Excludes binary On/Off and always-on/none.
  const isTop = profile.kind === 'graded' && count >= 3 && idx === count - 1;
  const motion = !reduceMotion;
  const slideShimmer = motion && isDragging && idx >= 1 && frac > 0;   // alive while sliding
  const animate = slideShimmer || (isTop && motion);                  // dot-shimmer animation gate
  const twinkleVisible = isDragging || isTop;                         // render the dot grid (drag or summit)
  const sweepOn = isTop && motion;                                    // specular sweep — ALWAYS on at the top stop
  // A static "maxed" cue so the bar reads densest/brightest even between sweeps.
  const fillPct = isTop ? 32 : 26;

  const trackStyle = React.useMemo<React.CSSProperties>(() => ({
    position: 'absolute',
    top: '50%',
    left: INSET,
    right: INSET,
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    transform: 'translateY(-50%)',
    overflow: 'hidden',
    background: 'var(--border-strong)',
    pointerEvents: 'none',
    contain: 'layout paint',
    isolation: 'isolate',
  }), []);

  const fillStyle = React.useMemo<React.CSSProperties>(() => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: `calc(${frac} * 100%)`,
    background: isTop ? `color-mix(in srgb, var(--accent) ${fillPct}%, transparent)` : 'color-mix(in srgb, var(--text) 30%, transparent)',
  }), [fillPct, frac, isTop]);

  const twinkleStyle = React.useMemo<React.CSSProperties>(() => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: `calc(${frac} * 100%)`,
    pointerEvents: 'none',
    backgroundImage: 'radial-gradient(circle at 1.6px 1.6px, rgba(255, 255, 255, 0.72) 1px, transparent 1.5px)',
    backgroundSize: '4.5px 4.5px',
    backgroundRepeat: 'repeat',
    ['--rsl-lo' as keyof React.CSSProperties]: twLo,
    animationName: animate ? 'rsl-twinkle' : 'none',
    animationDuration: twDur,
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    opacity: 1,
    willChange: animate ? 'opacity' : 'auto',
  }), [animate, frac, twDur, twLo]);

  const sweepStyle = React.useMemo<React.CSSProperties>(() => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: '42%',
    pointerEvents: 'none',
    background: 'linear-gradient(100deg, transparent 0%, rgba(255, 255, 255, 0.08) 32%, rgba(255, 255, 255, 0.58) 50%, rgba(255, 255, 255, 0.08) 68%, transparent 100%)',
    transform: 'translateX(-140%)',
    mixBlendMode: 'screen',
    ['--rsl-sweep-peak' as keyof React.CSSProperties]: 0.46,
    ['--rsl-sweep-still' as keyof React.CSSProperties]: 0.3,
    animationName: sweepOn ? 'rsl-sweep' : 'none',
    animationDuration: '3s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    opacity: sweepOn ? undefined : 0,
    willChange: sweepOn ? 'transform, opacity' : 'auto',
  }), [sweepOn]);

  const knobStyle = React.useMemo<React.CSSProperties>(() => ({
    position: 'absolute',
    top: '50%',
    left: stopLeft(idx),
    width: KNOB_W,
    height: KNOB_H,
    borderRadius: 6,
    transform: 'translate(-50%, -50%)',
    background: 'var(--text)',
    // Static accent halo at the summit (the "maxed" knob cue) — a fixed shadow,
    // not an animated one, so it costs no repaint loop.
    boxShadow: isTop
      ? '0 0 0 2px color-mix(in srgb, var(--accent) 42%, transparent), 0 0 9px color-mix(in srgb, var(--accent) 40%, transparent), 0 1px 3px rgba(0, 0, 0, 0.45)'
      : '0 1px 3px rgba(0, 0, 0, 0.45)',
    pointerEvents: 'none',
  }), [idx, isTop, stopLeft]);

  const stopDots = React.useMemo(() => opts.map((o, i) => (
    <div
      key={o.level}
      aria-hidden
      style={{ ...stopDotStyle, left: stopLeft(i) }}
    />
  )), [opts, stopLeft]);

  return (
    <div style={outerStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.6 }}>Effort </span>
          <b style={{ color: isTop ? 'var(--accent)' : 'var(--text)' }}>{opts[idx]?.label ?? ''}</b>
        </span>
        <span
          title="Higher effort = more reasoning before answering (slower). Fast mode forces the minimum."
          style={helpStyle}
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
        style={railStyle}
      >
        {/* track — a thick rounded bar; the FILLED portion carries the dotted
            accent shimmer; a white pill knob rides above it (Claude-Code look).
            The drag target is this wrapper (railRef); inner layers are inert. */}
        <div style={trackStyle}>
          {/* filled base — NEUTRAL grey up to the knob at every tier; only the
              TOP tier lights up to the accent wash (per spec: colour at the summit). */}
          <div style={fillStyle} />
          {/* dotted shimmer — a tiled dot GRID whose opacity breathes. Shown WHILE
              DRAGGING (slide feedback, escalating toward the top) and ALWAYS at the
              top tier; at rest below the top the bar stays a clean neutral fill.
              Decorative (pointerEvents:none). */}
          {twinkleVisible ? (
            <div
              className="rsl-twinkle"
              aria-hidden
              style={twinkleStyle}
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
              style={sweepStyle}
            />
          ) : null}
        </div>
        {/* level stop dots — small neutral markers so the tiers are visible. One
            coordinated soft grey for ALL of them (no purple cue): colour is
            reserved for the top tier, where the whole bar lights up. */}
        {stopDots}
        {/* knob — white rounded pill, above the track (taller than the bar) */}
        <div style={knobStyle} />
      </div>
      <div style={labelRowStyle}>
        <span>{profile.kind === 'binary' ? 'Off' : 'Faster'}</span>
        <span>{profile.kind === 'binary' ? 'On' : 'Smarter'}</span>
      </div>
    </div>
  );
}

export const ReasoningSlider = React.memo(ReasoningSliderComponent);
ReasoningSlider.displayName = 'ReasoningSlider';
