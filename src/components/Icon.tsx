/** Inline stroke icons, drawn on a 24 × 24 grid. */
const PATHS = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  external: <><path d="M14 5h5v5" /><path d="m19 5-8 8" /><path d="M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" /></>,
  download: <><path d="M12 4v11" /><path d="m7.5 11 4.5 4.5 4.5-4.5" /><path d="M5 19.5h14" /></>,
  reset: <><path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5" /><path d="M4.5 4.5v4h4" /></>,
  spin: <><ellipse cx="12" cy="12" rx="9" ry="3.8" /><circle cx="12" cy="12" r="2.6" /></>,
  swap: <><path d="M7 4 3.5 7.5 7 11" /><path d="M3.5 7.5h14" /><path d="m17 13 3.5 3.5L17 20" /><path d="M20.5 16.5h-14" /></>,
  compare: <><circle cx="9" cy="12" r="5.5" /><circle cx="15" cy="12" r="5.5" /></>,
  molecule: <><circle cx="6.5" cy="16.5" r="2.5" /><circle cx="17" cy="17.5" r="2" /><circle cx="12.5" cy="6.5" r="3" /><path d="m8 14.5 3-5.5M14 9l2.2 6.7M9 16.8l6 .5" /></>,
  warning: <><path d="M12 4 3 19.5h18L12 4Z" /><path d="M12 10v4.5M12 17.2v.1" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
