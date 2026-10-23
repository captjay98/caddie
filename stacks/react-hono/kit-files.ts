/**
 * The recipe kit's starter files (plan part O, lane 9).
 *
 * Part O's RECIPES — the short "one supported way" blocks — are written by
 * lane 1 in recipe.ts. The FILES two of those recipes point at are generated
 * into every app and owned here:
 *
 *   caddie/charts.tsx   bar, line and donut charts drawn as SVG, with no new
 *                       library and text a screen reader can read. The "Charts"
 *                       recipe tells a builder to import these.
 *   caddie/poll.ts      usePolling(load, 5000): re-run a loader every few
 *                       seconds for data that refreshes, pausing while the tab
 *                       is hidden. The "Refreshing data" recipe points here.
 *
 * Both are PROTECTED runtime files (caddie/). The other O recipes need no new
 * starter file: Search is FTS5 in a builder migration (LOCAL VERIFIED in S7 —
 * the sandbox/test database, the preview Durable Object and local D1 all run
 * FTS5), Maps pins Leaflet in the starter lock (lane 1, a lockfile change),
 * Location uses navigator.geolocation, and Admin/Teams are screens over the
 * generated access check and part K.
 *
 * The generated sources avoid backticks and "${" (except the ELL constant,
 * because bun's transpiler mangles a literal non-ASCII character inside
 * String.raw) so they can live in String.raw (same rule as auth-files.ts).
 */

const file = (text: string) => text.replace(/^\n/, '');

// Interpolated into String.raw: bun turns a LITERAL non-ASCII character inside
// String.raw into the text "\u2014"/"\u2026", so interpolate them to keep the
// real character while String.raw preserves the JSX/TS the files need.
const EM = '\u2014';
const ELL = '\u2026';

export const KIT_FILES: Readonly<Record<string, string>> = {
	'caddie/charts.tsx': file(String.raw`
// Caddie runtime file ${EM} do not edit. Bar, line and donut charts drawn as
// SVG ${EM} no chart library to add. Each chart has a role and an aria-label, and
// a visually-hidden table of its numbers, so a screen reader can read it.
//
//   import { BarChart, LineChart, DonutChart } from "../caddie/charts";
//   <BarChart title="Feed used this week" data={[{ label: "Mon", value: 12 }, { label: "Tue", value: 8 }]} />
//   <LineChart title="Weight over time" data={[{ label: "Jan", value: 40 }, { label: "Feb", value: 44 }]} />
//   <DonutChart title="By type" data={[{ label: "Hay", value: 3 }, { label: "Grain", value: 7 }]} />
//
// Colors come from the caddie-chart CSS classes in src/styles.css; style them
// there. Numbers are drawn to scale; an empty data array shows "No data yet".
import type { ReactNode } from "react";

export interface ChartPoint {
  label: string;
  value: number;
}

interface ChartProps {
  title: string;
  data: ChartPoint[];
  /** Overall width/height in CSS pixels. Height defaults to a readable ratio. */
  width?: number;
  height?: number;
}

function Empty(props: { title: string }) {
  return (
    <figure className="caddie-chart caddie-chart-empty">
      <figcaption>{props.title}</figcaption>
      <p>No data yet.</p>
    </figure>
  );
}

// A table of the numbers, only for screen readers. Every chart includes one, so
// the data is never trapped in the drawing.
function DataTable(props: { title: string; data: ChartPoint[] }) {
  return (
    <table className="caddie-visually-hidden">
      <caption>{props.title}</caption>
      <thead>
        <tr>
          <th scope="col">Label</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {props.data.map((point) => (
          <tr key={point.label}>
            <th scope="row">{point.label}</th>
            <td>{point.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Figure(props: { title: string; children: ReactNode; svg: ReactNode; width: number; height: number }) {
  return (
    <figure className="caddie-chart">
      <figcaption>{props.title}</figcaption>
      <svg role="img" aria-label={props.title} viewBox={"0 0 " + props.width + " " + props.height} width={props.width} height={props.height}>
        {props.svg}
      </svg>
      {props.children}
    </figure>
  );
}

export function BarChart({ title, data, width = 480, height = 240 }: ChartProps) {
  if (data.length === 0) return <Empty title={title} />;
  const pad = 24;
  const max = Math.max(...data.map((d) => d.value), 1);
  const bandWidth = (width - pad * 2) / data.length;
  const barWidth = bandWidth * 0.7;
  return (
    <Figure title={title} svg={data.map((point, i) => {
        const barHeight = ((height - pad * 2) * point.value) / max;
        const x = pad + i * bandWidth + (bandWidth - barWidth) / 2;
        const y = height - pad - barHeight;
        return <rect key={point.label} className="caddie-chart-bar" x={x} y={y} width={barWidth} height={Math.max(0, barHeight)} />;
      })} width={width} height={height}>
      <DataTable title={title} data={data} />
    </Figure>
  );
}

export function LineChart({ title, data, width = 480, height = 240 }: ChartProps) {
  if (data.length === 0) return <Empty title={title} />;
  const pad = 24;
  const max = Math.max(...data.map((d) => d.value), 1);
  const min = Math.min(...data.map((d) => d.value), 0);
  const span = max - min || 1;
  const step = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0;
  const points = data.map((point, i) => {
    const x = pad + i * step;
    const y = height - pad - ((height - pad * 2) * (point.value - min)) / span;
    return x + "," + y;
  });
  return (
    <Figure title={title} svg={<>
        <polyline className="caddie-chart-line" fill="none" points={points.join(" ")} />
        {data.map((point, i) => {
          const x = pad + i * step;
          const y = height - pad - ((height - pad * 2) * (point.value - min)) / span;
          return <circle key={point.label} className="caddie-chart-dot" cx={x} cy={y} r={3} />;
        })}
      </>} width={width} height={height}>
      <DataTable title={title} data={data} />
    </Figure>
  );
}

export function DonutChart({ title, data, width = 240, height = 240 }: ChartProps) {
  const total = data.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  if (data.length === 0 || total === 0) return <Empty title={title} />;
  const radius = Math.min(width, height) / 2 - 8;
  const cx = width / 2;
  const cy = height / 2;
  const inner = radius * 0.6;
  let angle = -Math.PI / 2;
  const arcs = data.map((point, i) => {
    const slice = (Math.max(0, point.value) / total) * Math.PI * 2;
    const start = angle;
    const end = angle + slice;
    angle = end;
    const large = slice > Math.PI ? 1 : 0;
    const x1 = cx + radius * Math.cos(start);
    const y1 = cy + radius * Math.sin(start);
    const x2 = cx + radius * Math.cos(end);
    const y2 = cy + radius * Math.sin(end);
    const xi2 = cx + inner * Math.cos(end);
    const yi2 = cy + inner * Math.sin(end);
    const xi1 = cx + inner * Math.cos(start);
    const yi1 = cy + inner * Math.sin(start);
    const d = "M " + x1 + " " + y1 + " A " + radius + " " + radius + " 0 " + large + " 1 " + x2 + " " + y2 +
      " L " + xi2 + " " + yi2 + " A " + inner + " " + inner + " 0 " + large + " 0 " + xi1 + " " + yi1 + " Z";
    return <path key={point.label} className={"caddie-chart-slice caddie-chart-slice-" + (i % 6)} d={d} />;
  });
  return (
    <Figure title={title} svg={arcs} width={width} height={height}>
      <DataTable title={title} data={data} />
    </Figure>
  );
}
`),

	'caddie/poll.ts': file(String.raw`
// Caddie runtime file ${EM} do not edit. Shared data that refreshes: run a
// loader every few seconds, and PAUSE while the browser tab is hidden (so a
// backgrounded tab makes no requests). Updates are not instant; this is the
// small, dependency-free way the starter supports refreshing.
//
//   import { usePolling } from "../caddie/poll";
//   const { data, error, loading, reload } = usePolling(
//     () => fetch("/api/animals").then((r) => r.json()),
//     5000,
//   );
//   if (loading) return <p>Loading${ELL}</p>;
//
// The loader runs once on mount, then every intervalMs while the tab is
// visible; it runs again right away when the tab becomes visible. reload()
// forces a fresh run.
import { useCallback, useEffect, useRef, useState } from "react";

export interface Polling<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function usePolling<T>(load: () => Promise<T>, intervalMs = 5000): Polling<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // Keep the latest loader without restarting the interval when it changes.
  const loader = useRef(load);
  loader.current = load;
  const inFlight = useRef(false);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await loader.current();
      setData(next);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (!hidden()) void run();
      }, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    void run();
    start();

    const onVisibility = () => {
      if (hidden()) {
        stop();
      } else {
        void run();
        start();
      }
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, run]);

  return { data, error, loading, reload: run };
}
`),

	'caddie/icons.tsx': file(String.raw`
// Caddie runtime file ${EM} do not edit. A small inline-SVG icon set so an app
// NEVER uses an emoji as an icon and adds no icon library. Each glyph is a 24x24
// stroke icon in currentColor; <Icon> is decorative (aria-hidden) by default, so
// pass a label ONLY for an icon that carries meaning on its own (an icon-only
// button): <Icon name="trash" label="Delete" />. Size with the "size" prop or
// font-size in CSS. Colour follows the surrounding text colour.
//
//   import { Icon } from "../caddie/icons";
//   <button><Icon name="plus" /> Add animal</button>         // label is on the button text
//   <button aria-label="Close"><Icon name="x" /></button>    // button already labelled
//   <Icon name="alert" label="Warning" />                    // standalone, needs a name
//
// The glyphs are hand-authored for Caddie in the common 24px geometric stroke
// style (the same visual idiom as Lucide, which is ISC-licensed:
// https://lucide.dev/license ${EM} MIT/ISC, "© Lucide Contributors"). No Lucide
// code or package is bundled; only this file's own paths ship in the app.
import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "check" | "x" | "plus" | "minus" | "alert" | "info" | "search" | "settings"
  | "trash" | "edit" | "save" | "home" | "user" | "users" | "bell" | "calendar"
  | "clock" | "mic" | "camera" | "image" | "file" | "download" | "upload"
  | "chevronLeft" | "chevronRight" | "chevronDown" | "chevronUp" | "arrowRight"
  | "star" | "heart" | "mapPin" | "refresh" | "menu" | "filter" | "eye";

// Each glyph is the inner markup of a 24x24 viewBox (no fill, stroke currentColor).
const PATHS: Record<IconName, ReactElement> = {
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  alert: <g><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></g>,
  info: <g><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></g>,
  search: <g><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></g>,
  settings: <g><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></g>,
  trash: <g><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" /><path d="M10 11v6M14 11v6" /></g>,
  edit: <g><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></g>,
  save: <g><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8" /></g>,
  home: <g><path d="m3 10 9-7 9 7" /><path d="M5 9v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M9 21v-6h6v6" /></g>,
  user: <g><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></g>,
  users: <g><circle cx="9" cy="8" r="3.5" /><path d="M2.5 21a6.5 6.5 0 0 1 13 0" /><path d="M16 5.5a3.5 3.5 0 0 1 0 6.9M18 21a6.5 6.5 0 0 0-3-5.5" /></g>,
  bell: <g><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></g>,
  calendar: <g><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></g>,
  clock: <g><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></g>,
  mic: <g><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" /></g>,
  camera: <g><path d="M3 7a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><circle cx="12" cy="13" r="4" /></g>,
  image: <g><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></g>,
  file: <g><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /></g>,
  download: <g><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></g>,
  upload: <g><path d="M12 21V9" /><path d="m7 13 5-5 5 5" /><path d="M5 3h14" /></g>,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  star: <path d="m12 3 2.9 5.9 6.1.9-4.5 4.3 1 6.1-5.5-2.9L6.5 20l1-6.1L3 9.8l6.1-.9Z" />,
  heart: <path d="M12 20s-7-4.4-9.3-8.6A4.6 4.6 0 0 1 12 6a4.6 4.6 0 0 1 9.3 5.4C19 15.6 12 20 12 20Z" />,
  mapPin: <g><path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11Z" /><circle cx="12" cy="10" r="2.5" /></g>,
  refresh: <g><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v4h-4" /></g>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4Z" />,
  eye: <g><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></g>,
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Size in px for both width and height. Defaults to 1em (follows font-size). */
  size?: number;
  /**
   * An accessible name. Give it ONLY when the icon stands alone and carries
   * meaning (an icon-only button or status). Leave it off for an icon beside
   * text; it is then aria-hidden and the text names the action.
   */
  label?: string;
}

export function Icon({ name, size, label, ...rest }: IconProps): ReactElement {
  const glyph = PATHS[name] ?? PATHS.info;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size ?? "1em"}
      height={size ?? "1em"}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable={false}
      {...rest}
    >
      {glyph}
    </svg>
  );
}
`),
};
