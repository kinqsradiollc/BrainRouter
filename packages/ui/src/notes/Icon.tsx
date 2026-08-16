import React from 'react';

/** Browser-safe glyphs used by the shared Notes presentation. */
const PATHS: Record<string, React.ReactNode> = {
  note: <><rect x="3" y="2" width="10" height="12" rx="1.2" /><path d="M5.4 5.2h5.2M5.4 8h5.2M5.4 10.8h3" /></>,
  plan: <path d="M3 4h1.5M3 8h1.5M3 12h1.5M7 4h6M7 8h6M7 12h6" />,
  panels: <path d="M3 4.5h10M3 8h10M3 11.5h10" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></>,
  copy: <path d="M5.5 5.5h8v8h-8v-8Zm-3-3h8v3h-5a1 1 0 0 0-1 1v4h-2v-8Z" />,
  close: <path d="m3.5 3.5 9 9m0-9-9 9" />,
  'chev-down': <path d="m3.5 6 4.5 4.5L12.5 6" />,
  'chev-right': <path d="m6 3.5 4.5 4.5L6 12.5" />,
  'chev-left': <path d="m10 3.5-4.5 4.5L10 12.5" />,
  'chev-up': <path d="m3.5 10 4.5-4.5L12.5 10" />,
  plus: <path d="M8 3v10M3 8h10" />,
  refresh: <path d="M13 5.5A5.5 5.5 0 0 0 3.8 3.3L2.5 4.6M3 10.5a5.5 5.5 0 0 0 9.2 2.2l1.3-1.3M2.5 1.8v2.8h2.8M13.5 14.2v-2.8h-2.8" />,
  export: <path d="M8 10V2m0 0L4.5 5.5M8 2l3.5 3.5M3 9v4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9" />,
  link: <path d="M6.5 9.5 9.5 6.5M5 11l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L3.5 5.5a2.5 2.5 0 0 1 3.5 0M11 5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5l-3.2 3.2a2.5 2.5 0 0 1-3.5 0" transform="scale(0.88) translate(1,1)" />,
  chart: <path d="M2.5 13.5v-5m4 5v-9m4 9v-6m4 6v-11" />,
  warn: <path d="M8 2 14.5 13.5h-13L8 2Zm0 4.5v3.5m0 2v.5" />,
  'arrow-left': <path d="M13 8H3m0 0 4.5-4.5M3 8l4.5 4.5" />,
  'arrow-right': <path d="M3 8h10m0 0L8.5 3.5M13 8l-4.5 4.5" />,
  dots: <><circle cx="3" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="13" cy="8" r="1.1" fill="currentColor" stroke="none" /></>,
  'check-circle': <><circle cx="8" cy="8" r="6" /><path d="m5.2 8.2 2 2 3.6-4" /></>,
  edit: <path d="m10.8 2.6 2.6 2.6-7.8 7.8-3.2.6.6-3.2 7.8-7.8Z" />,
  bubble: <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3.2 2.4V11.5h-.3a1 1 0 0 1-1-1v-6Z" />,
  expand: <path d="M9.5 2.5h4v4m-4 0 4-4M6.5 13.5h-4v-4m4 0-4 4" />,
  pin: <path d="M9.5 1.8 14.2 6.5l-2 .5-2.4 2.4.2 2.7-1.5 1.5-2.7-2.7L2.2 13l2.6-3.4-2.7-2.7L3.6 5.4l2.7.2L8.7 3.2l.8-1.4Z" />,
  trash: <path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5m-6.2 0 .6 8a1 1 0 0 0 1 1h4.2a1 1 0 0 0 1-1l.6-8M6.7 7v4M9.3 7v4" />,
};

export function Icon({ name, size = 16, className }: {
  name: string;
  size?: number;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      className={`ic${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name] ?? <circle cx="8" cy="8" r="5" />}
    </svg>
  );
}
