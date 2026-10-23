import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { KIT_FILES } from '../stacks/react-hono/kit-files.ts';
import { materializeFeatureApp, runFeatureTest, type FeatureApp } from './support/feature-app.ts';

/**
 * Part O starter files — the recipe kit (plan part O, lane 9).
 *
 * Lane 1 writes the recipes; lane 9 writes the two files two of them point at:
 * caddie/charts.tsx (SVG bar/line/donut with no new library and a screen-reader
 * table) and caddie/poll.ts (usePolling, pausing while the tab is hidden).
 *
 * Structural tests pin "no new library" and the a11y shape. The behavioural
 * test renders the real charts in happy-dom (the SVG draws to scale and the
 * screen-reader table carries the numbers) and drives usePolling through a
 * visibility change to prove it pauses while hidden and resumes when visible.
 * LOCAL VERIFIED.
 */

describe('part O: kit starter files — structure', () => {
	const charts = KIT_FILES['caddie/charts.tsx'] ?? '';
	const poll = KIT_FILES['caddie/poll.ts'] ?? '';

	test('both starter files exist', () => {
		expect(charts.length).toBeGreaterThan(0);
		expect(poll.length).toBeGreaterThan(0);
	});

	test('charts add NO new library and draw their own SVG', () => {
		expect(charts).toContain('export function BarChart');
		expect(charts).toContain('export function LineChart');
		expect(charts).toContain('export function DonutChart');
		expect(charts).toContain('<svg');
		// The only import is React types — no chart library.
		const imports = [...charts.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
		expect(imports).toEqual(['react']);
	});

	test('charts are readable: role="img", aria-label and a numbers table', () => {
		expect(charts).toContain('role="img"');
		expect(charts).toContain('aria-label');
		expect(charts).toContain('caddie-visually-hidden');
		expect(charts).toContain('<table');
	});

	test('usePolling exists and pauses while the tab is hidden', () => {
		expect(poll).toContain('export function usePolling');
		expect(poll).toContain('visibilitychange');
		expect(poll).toContain('"hidden"');
		// It must not restart the interval when the loader changes (a ref holds it).
		expect(poll).toContain('loader.current');
	});

	test('both are protected runtime files (do not edit)', () => {
		expect(charts).toContain('do not edit');
		expect(poll).toContain('do not edit');
	});
});

// --- behavioural: the real components in happy-dom ---------------------------

const CHART_TEST = [
	'import { describe, expect, test } from "bun:test";',
	'import { render } from "@testing-library/react";',
	'import { BarChart, LineChart, DonutChart } from "../caddie/charts";',
	'',
	'describe("charts render", () => {',
	'  test("a bar chart draws one bar per point, to scale, with a readable label and table", () => {',
	'    const { container, getByLabelText } = render(<BarChart title="Feed" data={[{ label: "Mon", value: 10 }, { label: "Tue", value: 5 }]} />);',
	'    expect(getByLabelText("Feed").tagName.toLowerCase()).toBe("svg");',
	'    const bars = container.querySelectorAll("rect.caddie-chart-bar");',
	'    expect(bars.length).toBe(2);',
	'    // The 10-value bar is taller than the 5-value bar (drawn to scale).',
	'    const h0 = Number(bars[0].getAttribute("height"));',
	'    const h1 = Number(bars[1].getAttribute("height"));',
	'    expect(h0).toBeGreaterThan(h1);',
	'    // The screen-reader table carries both numbers.',
	'    const table = container.querySelector("table.caddie-visually-hidden");',
	'    expect(table?.textContent).toContain("Mon");',
	'    expect(table?.textContent).toContain("10");',
	'  });',
	'',
	'  test("a line chart draws a polyline through every point", () => {',
	'    const { container } = render(<LineChart title="Weight" data={[{ label: "Jan", value: 40 }, { label: "Feb", value: 44 }, { label: "Mar", value: 42 }]} />);',
	'    const line = container.querySelector("polyline.caddie-chart-line");',
	'    expect(line).not.toBeNull();',
	'    expect((line?.getAttribute("points") ?? "").trim().split(" ").length).toBe(3);',
	'    expect(container.querySelectorAll("circle.caddie-chart-dot").length).toBe(3);',
	'  });',
	'',
	'  test("a donut chart draws one slice per point", () => {',
	'    const { container } = render(<DonutChart title="By type" data={[{ label: "Hay", value: 3 }, { label: "Grain", value: 7 }]} />);',
	'    expect(container.querySelectorAll("path.caddie-chart-slice").length).toBe(2);',
	'  });',
	'',
	'  test("an empty chart shows a plain no-data state, not a broken drawing", () => {',
	'    const { container, getByText } = render(<BarChart title="Nothing" data={[]} />);',
	'    expect(getByText("No data yet.")).toBeInTheDocument();',
	'    expect(container.querySelector("svg")).toBeNull();',
	'  });',
	'});',
	'',
].join('\n');

const POLL_TEST = [
	'import { afterEach, describe, expect, test } from "bun:test";',
	'import { render, waitFor, act } from "@testing-library/react";',
	'import { usePolling } from "../caddie/poll";',
	'',
	'function Probe({ load }) {',
	'  const { data, loading, reload } = usePolling(load, 20);',
	'  return <div><span data-testid="n">{loading ? "loading" : String(data)}</span><button onClick={reload}>reload</button></div>;',
	'}',
	'',
	'function setHidden(hidden) {',
	'  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });',
	'  document.dispatchEvent(new Event("visibilitychange"));',
	'}',
	'afterEach(() => setHidden(false));',
	'',
	'describe("usePolling", () => {',
	'  test("runs the loader on mount and keeps polling while visible", async () => {',
	'    let calls = 0;',
	'    const load = async () => ++calls;',
	'    const { getByTestId } = render(<Probe load={load} />);',
	'    await waitFor(() => expect(getByTestId("n").textContent).not.toBe("loading"));',
	'    const after = calls;',
	'    await new Promise((r) => setTimeout(r, 80));',
	'    expect(calls).toBeGreaterThan(after); // it kept polling',
	'  });',
	'',
	'  test("pauses while the tab is hidden and resumes when visible", async () => {',
	'    let calls = 0;',
	'    const load = async () => ++calls;',
	'    render(<Probe load={load} />);',
	'    await waitFor(() => expect(calls).toBeGreaterThan(0));',
	'    act(() => setHidden(true));',
	'    const atHide = calls;',
	'    await new Promise((r) => setTimeout(r, 80));',
	'    expect(calls).toBe(atHide); // no requests while hidden',
	'    act(() => setHidden(false));',
	'    await waitFor(() => expect(calls).toBeGreaterThan(atHide)); // resumed, ran once immediately',
	'  });',
	'});',
	'',
].join('\n');

describe('part O: kit components run for real', () => {
	let featureApp: FeatureApp;

	beforeAll(() => {
		featureApp = materializeFeatureApp([KIT_FILES], {
			'src/charts.test.tsx': CHART_TEST,
			'src/poll.test.tsx': POLL_TEST,
		});
	}, 240_000);

	afterAll(() => {
		featureApp?.cleanup();
	});

	test(
		'the charts render to scale with a readable table',
		() => {
			const result = runFeatureTest(featureApp, 'src/charts.test.tsx');
			expect(result.ok, result.out).toBe(true);
			expect(/\b4 pass\b/.test(result.out), result.out).toBe(true);
			expect(/\b0 fail\b/.test(result.out), result.out).toBe(true);
		},
		240_000,
	);

	test(
		'usePolling polls while visible and pauses while hidden',
		() => {
			const result = runFeatureTest(featureApp, 'src/poll.test.tsx');
			expect(result.ok, result.out).toBe(true);
			expect(/\b2 pass\b/.test(result.out), result.out).toBe(true);
			expect(/\b0 fail\b/.test(result.out), result.out).toBe(true);
		},
		180_000,
	);
});
