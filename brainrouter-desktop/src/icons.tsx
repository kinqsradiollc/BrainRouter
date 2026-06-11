/**
 * DESK-4k — the BrainRouter icon set. Minimal 16px line icons drawn as
 * inline SVG paths (stroke = currentColor) so they inherit text color and
 * scale crisply — replaces the emoji glyphs that rendered inconsistently
 * across platforms. Zero dependencies; every path is hand-rolled here.
 */
import React from 'react';

const PATHS: Record<string, React.ReactNode> = {
  folder: <path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.6 1.8h6.2a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8Z" />,
  'folder-open': <path d="M1.5 5.5v-1a1 1 0 0 1 1-1h3.2l1.6 1.8h5.2a1 1 0 0 1 1 1v.7m-12 6.5 1.7-5.4a1 1 0 0 1 .95-.7h8.9a1 1 0 0 1 .96 1.3l-1.4 4.1a1 1 0 0 1-.95.7h-9.2a1 1 0 0 1-.96-1Z" />,
  file: <path d="M4 1.5h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm5 0v3h3" />,
  terminal: <path d="M2 3.5h12v9H2v-9Zm2.5 2.5 2 2-2 2m3.5.5h3" />,
  diff: <path d="M8 1.5v5m-2.5-2.5h5M5.5 11.5h5M2.5 8.5h11" />,
  tasks: <><circle cx="4.5" cy="4.5" r="2" /><circle cx="11.5" cy="4.5" r="2" /><circle cx="4.5" cy="11.5" r="2" /><path d="M9.5 11.5h4" /></>,
  plan: <path d="M3 4h1.5M3 8h1.5M3 12h1.5M7 4h6M7 8h6M7 12h6" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></>,
  layout: <path d="M2 2.5h12v11H2v-11Zm4 0v11" />,
  'layout-right': <path d="M2 2.5h12v11H2v-11Zm8 0v11" />,
  gear: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" /></>,
  'arrow-up': <path d="M8 13V3m0 0L3.5 7.5M8 3l4.5 4.5" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  copy: <path d="M5.5 5.5h8v8h-8v-8Zm-3-3h8v3h-5a1 1 0 0 0-1 1v4h-2v-8Z" />,
  branch: <><circle cx="4.5" cy="3.5" r="1.8" /><circle cx="4.5" cy="12.5" r="1.8" /><circle cx="11.5" cy="6" r="1.8" /><path d="M4.5 5.3v5.4M11.5 7.8c0 2.5-3 2.5-5 3.3" /></>,
  close: <path d="m3.5 3.5 9 9m0-9-9 9" />,
  'chev-down': <path d="m3.5 6 4.5 4.5L12.5 6" />,
  'chev-right': <path d="m6 3.5 4.5 4.5L6 12.5" />,
  'chev-up': <path d="m3.5 10 4.5-4.5L12.5 10" />,
  plus: <path d="M8 3v10M3 8h10" />,
  command: <path d="M5.5 5.5h5v5h-5v-5Zm0 0H4a1.7 1.7 0 1 1 1.5-1.5v1.5Zm5 0H12a1.7 1.7 0 1 0-1.5-1.5v1.5Zm-5 5H4a1.7 1.7 0 1 0 1.5 1.5v-1.5Zm5 0H12a1.7 1.7 0 1 1-1.5 1.5v-1.5Z" />,
  sort: <path d="M5 3v10m0 0L2.5 10.5M5 13l2.5-2.5M11 13V3m0 0L8.5 5.5M11 3l2.5 2.5" />,
  export: <path d="M8 10V2m0 0L4.5 5.5M8 2l3.5 3.5M3 9v4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9" />,
  monitor: <path d="M2 3h12v8H2V3Zm4 11h4m-2-3v3" />,
  brain: <><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v11M4.5 4.5c2 1.5 5 1.5 7 0M4.5 11.5c2-1.5 5-1.5 7 0" /></>,
  link: <path d="M6.5 9.5 9.5 6.5M5 11l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L3.5 5.5a2.5 2.5 0 0 1 3.5 0M11 5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5l-3.2 3.2a2.5 2.5 0 0 1-3.5 0" transform="scale(0.88) translate(1,1)" />,
  chart: <path d="M2.5 13.5v-5m4 5v-9m4 9v-6m4 6v-11" />,
  palette: <><circle cx="8" cy="8" r="6" /><circle cx="5.8" cy="6" r="0.9" fill="currentColor" stroke="none" /><circle cx="10.2" cy="6" r="0.9" fill="currentColor" stroke="none" /><path d="M8 14c0-2.5 1.5-3 3.5-3 1.4 0 2.5-.8 2.5-3" /></>,
  shield: <path d="M8 1.8 13.5 4v4.2c0 3.3-2.3 5.4-5.5 6.6C4.8 13.6 2.5 11.5 2.5 8.2V4L8 1.8Z" />,
  eye: <><path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="1.8" /></>,
  bolt: <path d="M9 1.5 3.5 9H7l-1 5.5L11.5 7H8l1-5.5Z" />,
  warn: <path d="M8 2 14.5 13.5h-13L8 2Zm0 4.5v3.5m0 2v.5" />,
  spark: <path d="M8 1.5 9.3 6 14 8l-4.7 2L8 14.5 6.7 10 2 8l4.7-2L8 1.5Z" />,
};

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }): React.ReactElement {
  return (
    <svg className={`ic${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name] ?? <circle cx="8" cy="8" r="5" />}
    </svg>
  );
}
