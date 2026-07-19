"use client";

/**
 * EarthGlobe — a real rotating Earth for the Overview "What's new in cyber"
 * panel (ADR-019 D2 polish). Orthographic dot-matrix rendering of the actual
 * continents on <canvas>: coarse continent outlines (lon/lat polygons, hand
 * traced) are rasterized once into an equal-area dot field, then spun with
 * requestAnimationFrame. Self-contained — no geo assets, no chart library.
 *
 * Honors prefers-reduced-motion (renders a single static frame) and reads its
 * colors from the CSS custom properties so it follows the app theme.
 */
import { useEffect, useRef } from "react";

/** Rough continent outlines as [lon, lat] rings (degrees, E/N positive). */
const CONTINENTS: [number, number][][] = [
  // North America (Alaska → Canada → USA → Mexico → Central America)
  [[-168, 66], [-165, 60], [-158, 58], [-152, 60], [-140, 60], [-130, 55], [-125, 49], [-124, 40], [-117, 33], [-110, 24], [-105, 20], [-97, 16], [-90, 14], [-83, 9], [-81, 8], [-77, 8], [-82, 14], [-88, 16], [-91, 19], [-97, 26], [-93, 30], [-89, 29], [-84, 30], [-81, 25], [-80, 32], [-76, 35], [-70, 42], [-66, 45], [-60, 47], [-55, 52], [-58, 55], [-64, 60], [-70, 62], [-78, 62], [-85, 66], [-90, 69], [-102, 70], [-115, 70], [-128, 70], [-140, 70], [-155, 71], [-162, 70]],
  // Greenland
  [[-58, 76], [-52, 70], [-44, 60], [-40, 64], [-32, 68], [-22, 70], [-20, 75], [-30, 80], [-45, 82], [-58, 80]],
  // South America
  [[-77, 8], [-70, 12], [-62, 10], [-52, 5], [-44, -3], [-35, -6], [-35, -10], [-39, -15], [-41, -22], [-48, -26], [-53, -32], [-58, -38], [-62, -41], [-65, -47], [-68, -52], [-71, -54], [-73, -50], [-71, -42], [-70, -33], [-70, -25], [-70, -18], [-76, -14], [-81, -6], [-80, 0]],
  // Africa
  [[-6, 35], [3, 37], [11, 37], [20, 32], [32, 31], [35, 28], [43, 12], [51, 12], [46, -1], [40, -10], [36, -18], [33, -26], [27, -33], [20, -34], [17, -29], [14, -22], [12, -15], [9, -1], [6, 4], [-8, 5], [-13, 9], [-17, 15], [-16, 22], [-10, 29]],
  // Eurasia (Iberia → Scandinavia → Siberia → East/South Asia → Middle East)
  [[-9, 38], [-9, 43], [-2, 44], [-5, 48], [-1, 49], [3, 52], [8, 54], [8, 57], [12, 56], [18, 55], [21, 57], [24, 59], [28, 60], [28, 64], [24, 66], [22, 69], [28, 71], [35, 69], [42, 67], [50, 69], [60, 69], [68, 69], [75, 72], [85, 73], [95, 76], [105, 77], [115, 76], [125, 73], [135, 72], [142, 72], [150, 70], [160, 70], [170, 69], [178, 66], [178, 62], [170, 60], [162, 58], [158, 52], [150, 59], [142, 54], [135, 44], [130, 42], [126, 38], [122, 37], [120, 32], [122, 28], [115, 22], [108, 18], [105, 10], [103, 2], [100, 8], [98, 14], [94, 17], [90, 22], [87, 21], [80, 15], [77, 8], [73, 18], [70, 22], [66, 25], [61, 25], [57, 26], [52, 26], [56, 22], [53, 17], [45, 13], [43, 15], [39, 20], [35, 28], [32, 31], [27, 37], [23, 36], [19, 40], [15, 38], [12, 44], [5, 43], [0, 40]],
  // United Kingdom + Ireland (coarse)
  [[-10, 52], [-5, 50], [0, 51], [1, 53], [-2, 56], [-4, 58], [-8, 57], [-10, 54]],
  // Japan (coarse arc)
  [[129, 31], [132, 34], [136, 35], [140, 36], [141, 39], [142, 43], [144, 44], [141, 45], [139, 41], [136, 37], [132, 34.5], [129.5, 32.5]],
  // Sumatra / Malay peninsula
  [[95, 5], [102, 1], [106, -4], [103, -6], [98, -1], [95, 3]],
  // Borneo
  [[109, 1], [114, 5], [118, 2], [117, -2], [111, -4], [108, -2]],
  // New Guinea
  [[131, -1], [136, -2], [141, -3], [146, -6], [150, -9], [147, -10], [141, -8], [135, -4], [130, -2]],
  // Australia
  [[114, -22], [114, -34], [118, -35], [124, -33], [130, -32], [136, -35], [140, -38], [146, -39], [150, -37], [153, -30], [153, -25], [148, -20], [143, -14], [137, -12], [132, -11], [126, -14], [122, -17]],
  // New Zealand (coarse)
  [[172, -34], [176, -38], [178, -38], [175, -41], [172, -44], [168, -46], [166, -45], [170, -41], [172, -37]],
  // Madagascar
  [[44, -16], [47, -15], [50, -17], [49, -21], [47, -25], [44, -22], [43, -18]],
];

/** Ray-casting point-in-polygon on the lon/lat plane (fine at this coarseness). */
function inPolygon(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface LandDot { lon: number; lat: number }

let LAND_CACHE: LandDot[] | null = null;

/** Equal-area-ish dot field: fixed lat step, lon step widened toward the poles. */
function landDots(): LandDot[] {
  if (LAND_CACHE) return LAND_CACHE;
  const dots: LandDot[] = [];
  const STEP = 3;
  for (let lat = -85; lat <= 85; lat += STEP) {
    const lonStep = STEP / Math.max(0.3, Math.cos((lat * Math.PI) / 180));
    for (let lon = -180; lon < 180; lon += lonStep) {
      if (lat <= -70) { dots.push({ lon, lat }); continue; } // Antarctica
      if (CONTINENTS.some((ring) => inPolygon(lon, lat, ring))) dots.push({ lon, lat });
    }
  }
  LAND_CACHE = dots;
  return dots;
}

/** Pulsing detection markers (lon, lat): DC, São Paulo, London, Lagos, Singapore, Tokyo, Sydney. */
const MARKERS: [number, number][] = [[-77, 39], [-46, -23], [0, 51.5], [3, 6.5], [103.8, 1.3], [139.7, 35.7], [151.2, -33.9]];

const DEG = Math.PI / 180;
const TILT = 0.32; // radians — tip the axis toward the viewer a touch

export function EarthGlobe({ size = 150, className }: { size?: number; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // Resolve theme colors once per mount; sensible dark-theme fallbacks.
    const styleOf = getComputedStyle(canvas);
    const color = (name: string, fallback: string) => styleOf.getPropertyValue(name).trim() || fallback;
    const landColor = color("--text-secondary", "#9AA1A9");
    const oceanEdge = color("--border-med", "#3A3F45");
    const markerColor = color("--danger", "#E5534B");

    const dots = landDots();
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 2;
    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);

    const render = (rotationDeg: number, now: number) => {
      ctx.clearRect(0, 0, size, size);
      // Sphere body: soft top-left key light on the night side.
      const sphere = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.1, cx, cy, radius);
      sphere.addColorStop(0, "rgba(128, 134, 142, 0.16)");
      sphere.addColorStop(1, "rgba(128, 134, 142, 0.02)");
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = sphere;
      ctx.fill();
      ctx.strokeStyle = oceanEdge;
      ctx.lineWidth = 1;
      ctx.stroke();

      const project = (lon: number, lat: number): { x: number; y: number; z: number } => {
        const lambda = (lon + rotationDeg) * DEG;
        const phi = lat * DEG;
        const x0 = Math.cos(phi) * Math.sin(lambda);
        const y0 = Math.sin(phi);
        const z0 = Math.cos(phi) * Math.cos(lambda);
        return { x: x0, y: y0 * cosT + z0 * sinT, z: -y0 * sinT + z0 * cosT };
      };

      ctx.fillStyle = landColor;
      for (const dot of dots) {
        const p = project(dot.lon, dot.lat);
        if (p.z <= 0) continue; // back hemisphere
        ctx.globalAlpha = 0.18 + 0.62 * p.z;
        const r = (size / 240) * (0.65 + 0.55 * p.z);
        ctx.beginPath();
        ctx.arc(cx + radius * p.x, cy - radius * p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Detection markers pulse out of phase as they rotate through view.
      for (let i = 0; i < MARKERS.length; i++) {
        const p = project(MARKERS[i][0], MARKERS[i][1]);
        if (p.z <= 0.05) continue;
        const pulse = 0.5 + 0.5 * Math.sin(now / 420 + i * 1.7);
        const mx = cx + radius * p.x;
        const my = cy - radius * p.y;
        ctx.globalAlpha = (0.35 + 0.65 * pulse) * p.z;
        ctx.fillStyle = markerColor;
        ctx.beginPath();
        ctx.arc(mx, my, (size / 240) * (1.3 + pulse), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.18 * pulse * p.z;
        ctx.beginPath();
        ctx.arc(mx, my, (size / 240) * (3.4 + 2 * pulse), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = landColor;
      }
      ctx.globalAlpha = 1;
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      render(-30, 0);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      render(((now - start) / 1000) * 6 - 30, now); // 6°/s — one revolution per minute
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={canvasRef} className={className} style={{ width: size, height: size }} aria-hidden role="presentation" />;
}
