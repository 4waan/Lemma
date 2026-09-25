/** A small inline icon set: SVG elements, so nothing is fetched and the CSP needs no exception. */
const PATHS = {
  check: ["M20 6 9 17l-5-5"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  alert: ["M12 3 2 20.5h20L12 3z", "M12 10v4.5", "M12 17.5v.01"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5", "M12 7.5v.01"],
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"],
  package: ["M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9z", "M3 7.5 12 12l9-4.5", "M12 12v9"],
  resolution: ["M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5z", "M14 3v5h5", "M9 14.5l2 2 4-4"],
  receipt: ["M6 3h12v18l-3-2-3 2-3-2-3 2V3z", "M9 8h6", "M9 12h6"],
  shield: ["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number | undefined }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
