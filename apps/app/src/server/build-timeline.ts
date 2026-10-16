/**
 * Build timeline — the PURE derivation behind the build-progress view.
 *
 * Input is the app-owned `build_activity` ledger (one row per real sandbox
 * action the build host performed: scaffold setup, file writes, commands, host
 * checks) plus the workflow phase and the plan body. Output is a timeline a
 * non-technical person can read at a glance (one plain sentence, five stages
 * with how long each has taken) and a power user can drill into (every file,
 * every command, real test counts).
 *
 * Honesty rules:
 *   - Every number comes from a recorded row; nothing is estimated.
 *   - Plan items are the build's SCOPE ("what's being built"). No item is ever
 *     marked finished from file writes — nothing links a file to a feature, so
 *     guessing would be fabrication. Completion stays with the host checks.
 *   - A long silence is reported as silence ("no activity for 9 min"), never
 *     as "stuck" or as progress.
 *   - Times are wall-clock windows (first → last action of that kind). Work is
 *     iterative (write → test → write), so windows can overlap; labels say
 *     "for 12 min", not "took 12 min of a sequence".
 *
 * No I/O, no clock: `nowMs` is passed in. Unit-tested in
 * tests/build-timeline.test.ts.
 */

export type ActivityKind = 'setup' | 'file' | 'command' | 'check';
export type ActivityOutcome = 'ok' | 'failed' | 'cancelled';

/** One build_activity row as the server reads it. */
export interface ActivityRow {
	readonly kind: ActivityKind;
	readonly role: string | null;
	readonly subject: string;
	readonly outcome: ActivityOutcome;
	readonly exitCode: number | null;
	readonly testsPassed: number | null;
	readonly testsFailed: number | null;
	readonly bytes: number | null;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
}

export type TimelinePhase = 'planning' | 'review' | 'building' | 'blocked' | 'ready';
export type StageKey = 'setup' | 'write' | 'test' | 'check' | 'preview';
export type StageState = 'done' | 'active' | 'pending' | 'failed';

export interface TimelineStage {
	readonly key: StageKey;
	readonly label: string;
	readonly state: StageState;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	/** Window length; for the active stage it runs to `now`. Null when never started. */
	readonly durationMs: number | null;
	/** Plain detail, e.g. "23 files", "12 passing · 2 failing". */
	readonly detail: string | null;
}

export type FileArea = 'app' | 'test' | 'style' | 'config' | 'server';

export interface TimelineFile {
	/** Workspace-relative path. */
	readonly path: string;
	readonly area: FileArea;
	readonly writes: number;
	readonly lastAt: string;
	readonly bytes: number | null;
	readonly role: string | null;
}

export interface TimelineCommand {
	/** Command line with the workspace `cd … &&` prefix removed. */
	readonly command: string;
	readonly outcome: ActivityOutcome;
	readonly exitCode: number | null;
	readonly testsPassed: number | null;
	readonly testsFailed: number | null;
	readonly at: string;
	readonly durationMs: number;
	readonly role: string | null;
}

export interface TimelineCheck {
	readonly name: string;
	readonly label: string;
	readonly passed: boolean;
	readonly at: string;
	readonly durationMs: number;
}

export interface BuildTimeline {
	readonly phase: TimelinePhase;
	/** First recorded action, or null before any. */
	readonly startedAt: string | null;
	readonly lastActivityAt: string | null;
	/** Build start → now (building) or → last action (finished). */
	readonly elapsedMs: number | null;
	/** Building only: time since the last recorded action. */
	readonly idleMs: number | null;
	/** Building and silent for longer than QUIET_AFTER_MS. */
	readonly quiet: boolean;
	/** One plain sentence for everyone. */
	readonly summary: string;
	readonly stages: readonly TimelineStage[];
	/** What the approved plan says is being built (scope, never ticked off here). */
	readonly scope: readonly string[];
	/** Distinct files, most recently written first. */
	readonly files: readonly TimelineFile[];
	readonly fileAreas: Readonly<Record<FileArea, number>>;
	/** Commands, newest first. */
	readonly commands: readonly TimelineCommand[];
	/** The most recent test run that printed counts. */
	readonly tests: { readonly passed: number; readonly failed: number; readonly at: string } | null;
	/** The latest host-check attempt (dependencies, behavior tests, bundle). */
	readonly checks: readonly TimelineCheck[];
}

/** Silence longer than this, while building, is reported as quiet. */
export const QUIET_AFTER_MS = 5 * 60_000;

const STAGE_LABELS: Record<StageKey, string> = {
	setup: 'Get the workspace ready',
	write: 'Write the app',
	test: 'Run its own tests',
	check: 'Final checks by Caddie',
	preview: 'Make the preview',
};

const CHECK_LABELS: Record<string, string> = {
	dependencies: 'Install packages',
	'behavior-tests': 'Behaviour tests',
	'browser-bundle': 'Build for the browser',
};

// --- small pure helpers --------------------------------------------------------

/**
 * Pass/fail counts from a test runner's output. Recognises Bun's summary
 * (" 12 pass", " 1 fail") and the common "3 passed | 1 failed" form. Returns
 * null when no count was printed — never a guess.
 */
export function parseTestCounts(output: string): { passed: number; failed: number } | null {
	const bunPass = /^\s*(\d+)\s+pass\s*$/m.exec(output);
	const bunFail = /^\s*(\d+)\s+fail\s*$/m.exec(output);
	if (bunPass || bunFail) {
		return { passed: Number(bunPass?.[1] ?? 0), failed: Number(bunFail?.[1] ?? 0) };
	}
	const passed = /(\d+)\s+passed\b/i.exec(output);
	const failed = /(\d+)\s+failed\b/i.exec(output);
	if (passed || failed) return { passed: Number(passed?.[1] ?? 0), failed: Number(failed?.[1] ?? 0) };
	return null;
}

/** True when a command runs the project's tests. */
export function isTestCommand(command: string): boolean {
	return /(?:^|[;&|\n(]|&&)\s*(?:bun|npm|pnpm|yarn|npx|bunx)\s+(?:run\s+)?(?:test|vitest|jest)\b/.test(command);
}

/** A plain bucket for a file path, so "23 files" can read "14 app · 6 tests · 3 setup". */
export function fileArea(path: string): FileArea {
	const p = path.toLowerCase();
	if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return 'test';
	if (/\.(css|scss|sass|less)$/.test(p)) return 'style';
	if (/(^|\/)(package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|\.gitignore|wrangler\.jsonc?)$/.test(p) || /\.(toml|ya?ml|lock)$/.test(p)) {
		return 'config';
	}
	if (/(^|\/)(server|api|worker|routes|db)\//.test(p) || /(^|\/)server\.[cm]?[jt]sx?$/.test(p)) return 'server';
	return 'app';
}

/** Workspace-relative path: drops the `/workspace/<projectId>/` root. */
export function relativePath(path: string): string {
	return path.replace(/^\/workspace\/[^/]+\//, '').replace(/^\.\//, '');
}

/**
 * Make a recorded command line readable on one row:
 *   - drops a leading `cd /workspace/<id> && ` so it reads as written;
 *   - collapses a heredoc (`cmd … <<'EOF' … EOF`) to its command + a
 *     "(heredoc)" marker — the body is a file's contents, not something a
 *     person reads in a command list;
 *   - otherwise folds any remaining newlines to single spaces and keeps the
 *     first segment, with an "…" marker when more followed.
 * Honest: it never invents a command, only shortens a real one for display.
 */
export function cleanCommand(command: string): string {
	let text = command.replace(/^\s*cd\s+\/workspace\/[^\s;&]+\s*&&\s*/, '').trim();
	// Heredoc: keep the part before `<<`, note that a block body followed.
	const heredoc = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.exec(text);
	if (heredoc) {
		const head = text.slice(0, heredoc.index).replace(/\s+/g, ' ').trim();
		return `${head} … (heredoc)`;
	}
	if (/[\r\n]/.test(text)) {
		const firstLine = text.split(/[\r\n]+/).find((line) => line.trim() !== '')?.trim() ?? text.trim();
		return `${firstLine} …`;
	}
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * The build's scope from the approved plan body: the items under a
 * "User stories" / "Features" / "Requirements" heading (markdown heading or a
 * bold label), with "As a farmer, I want to …" trimmed to the want. At most
 * `limit` items. Empty when the plan lists none — nothing is invented.
 */
export function planScope(body: string | null | undefined, limit = 8): string[] {
	if (!body) return [];
	const lines = body.split('\n');
	const heading = /^(?:#{1,6}\s*|\*\*)\s*(?:user stories|stories|features|key features|core features|functional requirements|requirements|what (?:it|the app) (?:does|will do))\b/i;
	const items: string[] = [];
	let inSection = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (heading.test(line)) {
			inSection = true;
			continue;
		}
		if (!inSection) continue;
		// A new heading or bold label ends the section.
		if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?/.test(line)) {
			if (items.length > 0) break;
			inSection = false;
			continue;
		}
		const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (!bullet) continue;
		const text = tidyStory(bullet[1]!);
		if (text) items.push(text);
		if (items.length >= limit) break;
	}
	return items;
}

function tidyStory(text: string): string {
	let t = text.replace(/\*\*/g, '').trim();
	// "As a farmer, I want to log feed so I can track intake." → "Log feed so I can track intake"
	t = t.replace(/^as an?\s+[^,]+,\s*i\s+(?:want|need|would like)\s+(?:to\s+)?/i, '');
	t = t.replace(/\.$/, '').trim();
	return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

function ms(iso: string): number {
	const value = Date.parse(iso);
	return Number.isFinite(value) ? value : 0;
}

/** "4 min", "1 h 05 min", "40 s" — compact, for detail strings built here. */
export function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

// --- the derivation --------------------------------------------------------------

export function buildTimeline(input: {
	readonly phase: TimelinePhase;
	readonly rows: readonly ActivityRow[];
	readonly planBody?: string | null;
	/** The workflow's blocker text, used as the summary when blocked. */
	readonly blockedDetail?: string | null;
	readonly nowMs: number;
}): BuildTimeline {
	const rows = [...input.rows].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
	const { phase, nowMs } = input;
	const building = phase === 'building';
	const first = rows[0] ?? null;
	const last = rows.at(-1) ?? null;
	const startedAt = first?.startedAt ?? null;
	const lastActivityAt = last ? (rows.reduce((a, r) => (ms(r.finishedAt) > ms(a) ? r.finishedAt : a), last.finishedAt)) : null;
	const elapsedMs = startedAt
		? Math.max(0, (building ? nowMs : ms(lastActivityAt!)) - ms(startedAt))
		: null;
	const idleMs = building && lastActivityAt ? Math.max(0, nowMs - ms(lastActivityAt)) : null;
	const quiet = idleMs !== null && idleMs > QUIET_AFTER_MS;

	// Files: one entry per path, most recent first.
	const fileMap = new Map<string, { path: string; writes: number; lastAt: string; bytes: number | null; role: string | null }>();
	for (const row of rows) {
		if (row.kind !== 'file' || row.outcome !== 'ok') continue;
		const path = relativePath(row.subject);
		const prev = fileMap.get(path);
		fileMap.set(path, {
			path,
			writes: (prev?.writes ?? 0) + 1,
			lastAt: row.finishedAt,
			bytes: row.bytes ?? prev?.bytes ?? null,
			role: row.role ?? prev?.role ?? null,
		});
	}
	const files: TimelineFile[] = [...fileMap.values()]
		.map((f) => ({ ...f, area: fileArea(f.path) }))
		.sort((a, b) => ms(b.lastAt) - ms(a.lastAt));
	const fileAreas: Record<FileArea, number> = { app: 0, test: 0, style: 0, config: 0, server: 0 };
	for (const f of files) fileAreas[f.area] += 1;

	const commandRows = rows.filter((r) => r.kind === 'command');
	const commands: TimelineCommand[] = commandRows
		.map((r) => ({
			command: cleanCommand(r.subject),
			outcome: r.outcome,
			exitCode: r.exitCode,
			testsPassed: r.testsPassed,
			testsFailed: r.testsFailed,
			at: r.startedAt,
			durationMs: r.durationMs,
			role: r.role,
		}))
		.reverse();

	const testRuns = commandRows.filter((r) => r.testsPassed !== null || r.testsFailed !== null || isTestCommand(r.subject));
	const countedRun = [...testRuns].reverse().find((r) => r.testsPassed !== null || r.testsFailed !== null) ?? null;
	const tests = countedRun
		? { passed: countedRun.testsPassed ?? 0, failed: countedRun.testsFailed ?? 0, at: countedRun.finishedAt }
		: null;

	// Host checks: the latest attempt is the run of check rows after the last
	// non-check action (a new attempt starts after more work happened).
	const checkRows = rows.filter((r) => r.kind === 'check');
	const lastNonCheck = [...rows].reverse().find((r) => r.kind !== 'check') ?? null;
	const latestAttempt = checkRows.filter((r) => !lastNonCheck || ms(r.startedAt) >= ms(lastNonCheck.finishedAt));
	const attemptRows = latestAttempt.length > 0 ? latestAttempt : checkRows.slice(-3);
	const checks: TimelineCheck[] = attemptRows.map((r) => ({
		name: r.subject,
		label: CHECK_LABELS[r.subject] ?? r.subject,
		passed: r.outcome === 'ok',
		at: r.startedAt,
		durationMs: r.durationMs,
	}));

	// Stages.
	const kindFor: Record<Exclude<StageKey, 'preview'>, (r: ActivityRow) => boolean> = {
		setup: (r) => r.kind === 'setup',
		write: (r) => r.kind === 'file' || (r.kind === 'command' && !testRuns.includes(r)),
		test: (r) => testRuns.includes(r),
		check: (r) => r.kind === 'check',
	};
	const latestStage: StageKey | null = last
		? (Object.keys(kindFor) as Exclude<StageKey, 'preview'>[]).find((key) => kindFor[key](last)) ?? null
		: null;
	const checksFailed = checks.length > 0 && checks.some((c) => !c.passed);

	const stage = (key: Exclude<StageKey, 'preview'>): TimelineStage => {
		const own = rows.filter(kindFor[key]);
		const startedAtStage = own[0]?.startedAt ?? null;
		const endedAtStage = own.length ? own.reduce((a, r) => (ms(r.finishedAt) > ms(a) ? r.finishedAt : a), own[0]!.finishedAt) : null;
		let state: StageState = own.length === 0 ? 'pending' : 'done';
		if (own.length > 0 && building && latestStage === key) state = 'active';
		// Iterative work loops back (write → test → write): a stage whose LATEST
		// result failed reads as failed, not done, until a later result passes.
		else if (key === 'test' && tests && tests.failed > 0) state = 'failed';
		else if (key === 'check' && checksFailed) state = 'failed';
		// The scaffold is uploaded once per workspace; a resumed run may have no
		// setup row even though the workspace evidently exists.
		if (key === 'setup' && own.length === 0 && rows.length > 0) state = 'done';
		if (phase === 'ready' && own.length > 0) state = 'done';
		const durationMs = startedAtStage
			? Math.max(0, (state === 'active' ? nowMs : ms(endedAtStage!)) - ms(startedAtStage))
			: null;
		let detail: string | null = null;
		if (key === 'write' && files.length > 0) detail = `${files.length} file${files.length === 1 ? '' : 's'}`;
		if (key === 'test') {
			detail = tests
				? `${tests.passed} passing${tests.failed > 0 ? ` · ${tests.failed} failing` : ''}`
				: testRuns.length > 0
					? `${testRuns.length} run${testRuns.length === 1 ? '' : 's'}`
					: null;
		}
		if (key === 'check' && checks.length > 0) {
			const passed = checks.filter((c) => c.passed).length;
			detail = `${passed} of ${checks.length} passed`;
		}
		return { key, label: STAGE_LABELS[key], state, startedAt: startedAtStage, endedAt: endedAtStage, durationMs, detail };
	};
	const stages: TimelineStage[] = [
		stage('setup'),
		stage('write'),
		stage('test'),
		stage('check'),
		{
			key: 'preview',
			label: STAGE_LABELS.preview,
			state: phase === 'ready' ? 'done' : 'pending',
			startedAt: null,
			endedAt: phase === 'ready' ? lastActivityAt : null,
			durationMs: null,
			detail: phase === 'ready' ? 'Ready to try' : null,
		},
	];

	return {
		phase,
		startedAt,
		lastActivityAt,
		elapsedMs,
		idleMs,
		quiet,
		summary: summaryFor({ phase, rows, files, tests, checks, latestStage, quiet, idleMs, elapsedMs, blockedDetail: input.blockedDetail ?? null }),
		stages,
		scope: planScope(input.planBody),
		files,
		fileAreas,
		commands,
		tests,
		checks,
	};
}

function summaryFor(s: {
	phase: TimelinePhase;
	rows: readonly ActivityRow[];
	files: readonly TimelineFile[];
	tests: BuildTimeline['tests'];
	checks: readonly TimelineCheck[];
	latestStage: StageKey | null;
	quiet: boolean;
	idleMs: number | null;
	elapsedMs: number | null;
	blockedDetail: string | null;
}): string {
	if (s.phase === 'planning' || s.phase === 'review') return 'Nothing is being built yet — the plan comes first.';
	if (s.phase === 'ready') {
		return s.elapsedMs !== null
			? `Built and checked in ${formatDuration(s.elapsedMs)}. Your app is ready to try.`
			: 'Built and checked. Your app is ready to try.';
	}
	if (s.phase === 'blocked') return s.blockedDetail?.trim() || 'The build stopped before it finished. Your files are kept.';
	// building
	if (s.rows.length === 0) return 'Caddie is getting the workspace ready.';
	if (s.quiet && s.idleMs !== null) {
		return `No activity for ${formatDuration(s.idleMs)}. Caddie may be working through a hard step — you can stop the build at any time.`;
	}
	if (s.latestStage === 'check') {
		const failed = s.checks.filter((c) => !c.passed);
		return failed.length > 0
			? `A final check failed (${failed.map((c) => c.label.toLowerCase()).join(', ')}). Caddie is fixing it.`
			: 'Running the final checks.';
	}
	if (s.latestStage === 'test' && s.tests) {
		return s.tests.failed > 0
			? `Its own tests: ${s.tests.passed} passing, ${s.tests.failed} failing. Caddie is fixing them.`
			: `Its own tests are passing (${s.tests.passed}).`;
	}
	if (s.latestStage === 'test') return 'Running its own tests.';
	if (s.files.length > 0) return `Writing the app — ${s.files.length} file${s.files.length === 1 ? '' : 's'} so far.`;
	return 'Caddie is setting up the app.';
}
