import type { StackRecipe } from "@caddie/contracts";

/**
 * react-hono stack recipe — the FIRST stack to prove (P09). Commands are
 * curated, never model-supplied (contracts.md). The template ships with
 * pinned commands; the journey runs them inside the sandbox.
 *
 * LIVE VERIFIED at the P09 execution window: scripts/run-journey.ts executed
 * every acceptance-manifest phase inside the contree sandbox (install, tests,
 * build, deliberate red → repair, server-start, artifact export) plus real
 * browser assertions against the sandbox-built bundle — exit 0, evidence in
 * the execution ledger. Availability flipped to "verified" by that run, per
 * contracts.md: only the journey labels a stack verified.
 */
export const recipe: StackRecipe = {
	id: "react-hono",
	version: "1.0.0",
	// Digest of the template directory at freeze time; recomputed by the
	// journey runner before each run and refused on mismatch. (Frozen at the
	// P09 execution window: template = package.json + tsconfig.json.)
	imageDigest: "sha256:d6d5179e9dff098455cd3a31a1de3c4022fd84881fc2226c3e7c54f1f38563e0",
	install: ["bun install --frozen-lockfile"],
	test: ["bun run test"],
	build: ["bun run build"],
	start: ["bun run start"],
	requiredCapabilities: ["bun"],
	artifacts: ["dist/", "coverage/"],
	preview: "server",
	// Flipped from "unverified" by the P09 journey (LIVE, exit 0, all phases).
	availability: "verified",
};

/**
 * The ONE Leaflet release pinned in the starter (part O, Maps recipe). The
 * version and its integrity are fixed here so the starter's bun.lock resolves
 * exactly this build and no floating one; scripts/refresh-scaffold-lock.ts
 * reads LEAFLET_VERSION as the scaffold's declared dependency, and the recipe
 * test pins LEAFLET_INTEGRITY against the generated lock.
 *
 * Picked on 2026-10-23 from the npm registry's current `leaflet@latest` and
 * verified byte-for-byte: the downloaded tarball's sha512 equals the
 * registry's recorded integrity.
 */
export const LEAFLET_VERSION = "1.9.4";
export const LEAFLET_INTEGRITY =
	"sha512-nxS1ynzJOmOlHp+iL3FyWqK89GtNL8U8rvlMOsQdTTssxZwCXh8N2NB3GDQOL+YR3XnWyZAxwQixURb+FA74PA==";

/**
 * Part O RECIPES — the one supported way to do each common thing in this
 * starter. Lane 1 writes them (plan part O); the build specialists receive
 * them through BUILD_RECIPE_INSTRUCTION (apps/app/src/agents/specialists.ts).
 * Kept terse on purpose: prompt size matters.
 *
 * The files two recipes point at (caddie/charts.tsx, caddie/poll.ts) ship in
 * every app and are owned by lane 9 (stacks/react-hono/kit-files.ts). Search
 * uses FTS5 (verified on the starter's bun:sqlite test DB, the preview
 * database and local D1 — S7). Maps pins Leaflet in the lock (above).
 */
export const RECIPES = [
	"RECIPES — the one supported way to do each of these in this starter; follow the one that fits and don't invent another:",
	"- Search: add an FTS5 table in a migration (CREATE VIRTUAL TABLE <name> USING fts5(<columns>);), keep it filled from the same write that updates your real table (insert the row's rowid + text into it), and query it with WHERE <name> MATCH ? ORDER BY rank. SQLite's FTS5 is available in the test DB, the preview and the published app.",
	"- Charts: import { BarChart, LineChart, DonutChart } from \"../caddie/charts\" (already in every app) and pass data={[{ label, value }]}. They draw their own SVG, add no library, and carry a screen-reader table; style them with the caddie-chart classes in src/styles.css. Never add a chart library.",
	"- Maps: Leaflet (pinned in the starter — import \"leaflet\" and \"leaflet/dist/leaflet.css\") with OpenStreetMap tiles (L.tileLayer(\"https://tile.openstreetmap.org/{z}/{x}/{y}.png\", { attribution: '© OpenStreetMap contributors' })); keep the attribution visible. Works in published apps, and in Caddie's preview too.",
	"- Location: navigator.geolocation.getCurrentPosition(ok, fail), and ALWAYS offer a \"type a place\" text fallback for when it is denied or unavailable. It works in Caddie's preview.",
	"- Refreshing data: import { usePolling } from \"../caddie/poll\" (already in every app) and const { data, loading, reload } = usePolling(load, 5000). It re-runs load every few seconds and pauses while the tab is hidden; updates are not instant. Use it, don't hand-roll a setInterval.",
	"- Admin pages: put admin screens behind an `admin` route, gate their /api routes on a signed-in user whose row is an admin, and give the app an \"Add admin\" action so the first owner can grant others.",
	"- Teams: a person creates a team, invites a teammate by email (Caddie's test inbox delivers it), the teammate accepts, and a team switcher changes which team's data is shown; scope the team's rows by team id and check membership in every route.",
].join("\n");
