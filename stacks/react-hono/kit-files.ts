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
};
