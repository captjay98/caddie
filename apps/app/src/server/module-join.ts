/**
 * Big apps (plan part P step 3, part Q): joining a finished part into the app.
 *
 * A part's builder calls finish_module once every feature of its part has
 * passed in its own copy. This file joins that part into the app:
 *
 *   1. Under the build's integration lock (integration.ts), the part's own
 *      folders are copied out of its finished copy into a JOIN COPY started
 *      from the NEWEST joined save point (the foundation row's checkpointRef,
 *      which every green join moves forward). A file the part changed outside
 *      its folders is reported, never copied.
 *   2. The full checks run on the join copy, with the contract covering every
 *      joined part's features plus this one's.
 *   3. Green: the join copy is committed as the new newest save point
 *      ("core + feed merged"), the build's own working copy is pointed at it
 *      (verify_build and the preview use it), the part's builder slot is
 *      freed and every part now ready starts from that save point.
 *   4. Red: the join copy is thrown away, so nothing changes in the app. The
 *      part goes back to its builder with the failures to fix in its own
 *      folders; it then calls finish_module again. After MAX_JOIN_TRIES red
 *      joins the part is "not joined", its slot is freed, and the rest of the
 *      app carries on without it (a part that needs it never starts).
 *   5. When nothing can make progress any more (big-build.bigBuildOutcome),
 *      the coordinator is told once, keyed, so it checks the whole app.
 *
 * integration.ts's own repair rounds are not used (maxRepairRounds 0): a
 * repair is the part's builder working in its own copy, which is an agent
 * turn, never something a merge can wait for while it holds the lock.
 *
 * Lock contention never loses a part: a part that cannot take the lock is
 * recorded "passed" and the holder's drain joins it too (integration.ts). Its
 * builder has ended its turn by then, so a red join for it is sent to that
 * builder as a new message.
 *
 * Everything that touches the sandbox is injected (JoinPorts), so this is
 * tested with an in-memory image store; coordinator-host.ts builds the real
 * ports.
 */
import type { ArchitectureBlock, Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import type { SnapshotReadPort } from './part-manifests.ts';
import { mergeFinishedModule, type CheckFailure, type MergeDeps } from './integration.ts';
import { getModule, listModules, moduleInstanceId, recordModuleAttempt, releaseSlot, setModuleStatus } from './module-slots.ts';
import { startReadyModules, type DispatchModuleBuilder } from './modules.ts';
import { bigBuildOutcome, foundationModuleOf } from './big-build.ts';
import { ScopeError } from './scope.ts';

/** How many times a part is joined before it is "not joined" (plan part Q). */
export const MAX_JOIN_TRIES = 2;
/** The longest check output handed back to a builder, per failure. */
const FAILURE_OUTPUT_LIMIT = 2_000;

/** A copy of the app the join writes into and checks. Thrown away on red. */
export interface JoinCopy {
	/** Write files (workspace-relative paths, base64) in one commit. */
	write(files: ReadonlyArray<{ path: string; contentBase64: string }>): Promise<void>;
	/**
	 * The full checks on this copy. `features`: every joined part's planned
	 * features plus the joining part's, for the generated contract test. A
	 * failure here never counts toward any repair limit.
	 */
	runChecks(input: { attempt: string; features: readonly string[] }): Promise<{ passed: boolean; failures: readonly CheckFailure[] }>;
	/** Commit the copy; returns the new image (the save point's ref). */
	checkpoint(): Promise<string>;
}

/** The sandbox-facing ports, injected. */
export interface JoinPorts {
	/** Start a fresh join copy from a committed image, under a new session key. */
	openCopy(image: string, key: string): Promise<JoinCopy>;
	/** A read port over a committed image (a part's finished copy, or a save point). */
	readSnapshot(image: string): SnapshotReadPort & { image: string };
	/** One file's bytes from a committed image, base64. */
	readFile(image: string, path: string): Promise<string>;
	/** Point the build's own working copy at a joined save point. */
	pointBuildCopyAt(image: string, name: string): Promise<void>;
	/** Start a part's builder, or send a running one a message (Flue dispatch, at-least-once). */
	dispatch: DispatchModuleBuilder;
	/** A part's planned feature ids. */
	features(moduleId: string): readonly string[];
	/** Tell the coordinator every part is settled (keyed, so a resend is one turn). */
	notifyCoordinator?: (input: { key: string; message: string }) => Promise<void> | void;
}

/** One failing check, as the builder sees it. */
export interface JoinFailure {
	check: string;
	output: string;
}

export type JoinOutcome =
	| { joined: true; savePoint: string; next: string }
	| { joined: false; queued: true; next: string }
	| { joined: false; failures: JoinFailure[]; triesLeft: number; next: string }
	| { joined: false; final: true; reason: string; next: string };

const JOINED_NEXT = 'Your part is joined into the app. Your work is done: end your turn now.';
const QUEUED_NEXT =
	'Another part is being joined into the app right now; yours is joined right after it. End your turn now. If your part fails its join, you will get a new message with the failures.';
const FINAL_NEXT = 'Your part could not be joined into the app, so the app is finished without it; the rest still works. End your turn now.';

function plainFailures(failures: readonly CheckFailure[]): JoinFailure[] {
	return failures.map((f) => ({ check: f.check, output: (f.output ?? '').trim().slice(-FAILURE_OUTPUT_LIMIT) }));
}

function retryText(failures: readonly JoinFailure[], triesLeft: number): string {
	const lines = failures.map((f) => `- ${f.check}: ${f.output || '(no output)'}`).join('\n');
	return (
		`Joining your part into the app failed these checks:\n${lines}\n` +
		`Fix them in your part's own folders, get run_checks green, then call finish_module again. ` +
		`${triesLeft === 1 ? 'This is the last try' : `${triesLeft} tries are left`}; after that the app is finished without your part.`
	);
}

/** The message a queued part's builder gets when the holder's join of it was red. */
export function joinRetryMessage(moduleId: string, failures: readonly JoinFailure[], triesLeft: number): string {
	return `Your part "${moduleId}" was joined into the app while you waited, and it failed. ${retryText(failures, triesLeft)}`;
}

/** What the coordinator is told when every part is settled. */
export function partsSettledMessage(missing: ReadonlyArray<{ moduleId: string; reason: string }>): string {
	if (missing.length === 0)
		return 'Every part is joined into the app. Call build_next_feature to confirm nothing is left, then verify_build to check the whole app.';
	const why = (reason: string) => (reason === 'stopped' ? 'stopped' : reason === 'not-merged' ? 'could not be joined' : 'needs a part that is missing');
	return (
		`The parts are settled. Not in the app: ${missing.map((m) => `${m.moduleId} (${why(m.reason)})`).join(', ')}. ` +
		'Call build_next_feature, then verify_build to check the app as it stands.'
	);
}

/** A short, sandbox-safe session-key fragment from a tool call id. */
function keyPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, '').slice(-24) || 'call';
}

/**
 * Point the build's own working copy at a joined save point: the next time
 * the coordinator (verify_build, the preview) opens its working copy, it
 * starts from this image (working-copy.ts reads this session override, the
 * same row a rollback writes). Same image, same key: a replay is harmless.
 */
export async function pointBuildSessionAt(
	db: D1Database,
	input: { projectId: string; runId: string; image: string; name: string },
): Promise<void> {
	const stamp = new Date().toISOString();
	const sessionKey = `joined:${input.runId}:${keyPart(input.image)}`;
	// delete + insert, not ON CONFLICT: the local D1 emulator mishandles upserts (P08 note).
	await db.batch([
		db.prepare('delete from "build_sandbox_sessions" where "projectId" = ?').bind(input.projectId),
		db
			.prepare('insert into "build_sandbox_sessions" ("projectId","runId","sessionKey","image","reason","updatedAt") values (?,?,?,?,?,?)')
			.bind(input.projectId, input.runId, sessionKey, input.image, `joined:${input.name}`.slice(0, 500), stamp),
	]);
}

/**
 * After a part settles (joined, not joined, or stopped), keep the big build
 * moving: a finished part's builder slot is freed, every part that can start
 * now starts from the newest joined save point, and once nothing can make
 * progress any more the coordinator is told, keyed, so a second caller that
 * also sees the build settled sends the same one turn. Called after every
 * join and after a part stops — a stopped part's slot must go to the next
 * part, or a part waiting for a slot would never start.
 */
export async function continueBigBuild(
	db: D1Database,
	scope: Scope,
	input: { runId: string; buildSeq: number; block: ArchitectureBlock },
	ports: Pick<JoinPorts, 'dispatch' | 'features' | 'notifyCoordinator'>,
): Promise<{ settled: boolean }> {
	const projectId = scope.projectId;
	for (const m of await listModules(db, projectId, input.buildSeq))
		if (m.status === 'merged' || m.status === 'not-merged' || m.status === 'stopped') await releaseSlot(db, projectId, input.buildSeq, m.moduleId);
	const newest = (await getModule(db, projectId, input.buildSeq, foundationModuleOf(input.block)))?.checkpointRef;
	if (newest)
		await startReadyModules(db, scope, { runId: input.runId, buildSeq: input.buildSeq, latestMergedSave: newest, dispatch: ports.dispatch, features: (m) => ports.features(m) });
	const outcome = await bigBuildOutcome(db, projectId, input.buildSeq);
	if (outcome.done)
		await ports.notifyCoordinator?.({ key: `parts-settled:${input.runId}:${input.buildSeq}`, message: partsSettledMessage(outcome.missing) });
	return { settled: outcome.done };
}

/**
 * Join one finished part into the app (see the file header). `moduleRef` is a
 * fresh commit of the part's own copy, taken when its builder called
 * finish_module. Never throws for a red join: that is a result.
 */
export async function joinFinishedModule(
	db: D1Database,
	scope: Scope,
	input: { runId: string; buildSeq: number; moduleId: string; moduleRef: string; block: ArchitectureBlock; attempt: string },
	ports: JoinPorts,
): Promise<JoinOutcome> {
	const { runId, buildSeq, moduleId, block } = input;
	const projectId = scope.projectId;
	const foundation = foundationModuleOf(block);
	// A replayed call (tool calls are at-least-once) answers from where the
	// part already stands instead of joining it a second time.
	const before = await getModule(db, projectId, buildSeq, moduleId);
	if (!before) throw new ScopeError(404, 'NO_SUCH_PART', `"${moduleId}" is not a part of this build.`);
	if (before.status === 'merged') return { joined: true, savePoint: '', next: JOINED_NEXT };
	if (before.status === 'not-merged') return { joined: false, final: true, reason: 'This part could not be joined into the app.', next: FINAL_NEXT };
	if (before.status === 'stopped' || before.status === 'pending')
		throw new ScopeError(409, 'PART_NOT_BUILDING', `"${moduleId}" is not being built, so there is nothing to join.`);
	const newestAtStart = (await getModule(db, projectId, buildSeq, foundation))?.checkpointRef;
	if (!newestAtStart) throw new ScopeError(409, 'NOT_READY_TO_JOIN', 'The app has no joined save point to join this part into yet.');

	// The join copy and the image it holds. Opened lazily, thrown away on red
	// (restore), and moved forward by every green save point in this drain.
	let copy: JoinCopy | null = null;
	let copyImage = newestAtStart;
	let opens = 0;
	const useCopy = async (): Promise<JoinCopy> =>
		(copy ??= await ports.openCopy(copyImage, `join:${runId}:${buildSeq}:${moduleId}:${keyPart(input.attempt)}:${opens++}`));

	// Which part a check run is for: the merge reads the merging part's
	// snapshot just before it writes and checks (one round each, since
	// maxRepairRounds is 0), and every part's finished ref is its own image.
	let lastRead: string | null = null;
	const partWithRef = async (ref: string | null): Promise<string | null> => {
		if (ref === null) return null;
		if (ref === input.moduleRef) return moduleId;
		return (await listModules(db, projectId, buildSeq)).find((m) => m.status === 'passed' && m.checkpointRef === ref)?.moduleId ?? null;
	};
	const failuresOf = new Map<string, JoinFailure[]>();

	const deps: MergeDeps = {
		block,
		buildSeq,
		maxRepairRounds: 0,
		readModuleSnapshot: (ref) => {
			lastRead = ref;
			return ports.readSnapshot(ref);
		},
		readIntegrationSnapshot: () => ports.readSnapshot(copyImage),
		readModuleFile: (ref, path) => ports.readFile(ref, path),
		writeIntegration: async (files) => {
			await (await useCopy()).write(files);
		},
		// The copy as it stands before a part's writes is always `copyImage`:
		// opened from it, or committed as it by the last green save point.
		snapshotIntegration: async () => copyImage,
		restoreIntegration: async (ref) => {
			copy = null;
			copyImage = ref;
		},
		runChecks: async () => {
			const merging = await partWithRef(lastRead);
			const joined = (await listModules(db, projectId, buildSeq)).filter((m) => m.status === 'merged').map((m) => m.moduleId);
			const features = [...new Set([...joined, ...(merging ? [merging] : [])].flatMap((m) => ports.features(m)))];
			const result = await (await useCopy()).runChecks({ attempt: `${input.attempt}:${merging ?? 'part'}`, features });
			if (!result.passed && merging) failuresOf.set(merging, plainFailures(result.failures));
			return { passed: result.passed, failures: [...result.failures] };
		},
		savePoint: async (name) => {
			const ref = await (await useCopy()).checkpoint();
			copyImage = ref;
			// The foundation row carries the newest joined save point: every
			// later join, and every part that starts later, begins from it.
			await setModuleStatus(db, projectId, buildSeq, foundation, 'merged', { checkpointRef: ref });
			await ports.pointBuildCopyAt(ref, name);
			return ref;
		},
		dispatchRepair: async () => null,
	};

	const result = await mergeFinishedModule(db, scope, { runId, moduleId, checkpointRef: input.moduleRef }, deps);

	// This call's own part ended "not joined" without a check failure to show
	// (no attribution): it still spends a try, with nothing to report.
	if (!result.queued && !result.merged && !failuresOf.has(moduleId) && (await getModule(db, projectId, buildSeq, moduleId))?.status === 'not-merged')
		failuresOf.set(moduleId, []);

	// Every part this drain could not join spends one try. With tries left it
	// goes back to its builder; the caller's own builder gets the failures in
	// this call's result, a queued part's builder as a new message.
	for (const [part, failures] of failuresOf) {
		if ((await getModule(db, projectId, buildSeq, part))?.status !== 'not-merged') continue;
		const tries = await recordModuleAttempt(db, projectId, buildSeq, part);
		if (tries < MAX_JOIN_TRIES) {
			await setModuleStatus(db, projectId, buildSeq, part, 'building');
			if (part !== moduleId)
				await ports.dispatch({
					instanceId: moduleInstanceId(projectId, buildSeq, part),
					moduleId: part,
					buildSeq,
					features: ports.features(part),
					message: joinRetryMessage(part, failures, MAX_JOIN_TRIES - tries),
				});
		} else {
			await releaseSlot(db, projectId, buildSeq, part);
		}
	}
	await continueBigBuild(db, scope, { runId, buildSeq, block }, ports);

	if (result.queued) return { joined: false, queued: true, next: QUEUED_NEXT };
	if (result.merged) return { joined: true, savePoint: result.savePoint ?? '', next: JOINED_NEXT };
	const own = await getModule(db, projectId, buildSeq, moduleId);
	if (own?.status === 'building') {
		const failures = failuresOf.get(moduleId) ?? [];
		const triesLeft = MAX_JOIN_TRIES - own.attempts;
		return { joined: false, failures, triesLeft, next: retryText(failures, triesLeft) };
	}
	return { joined: false, final: true, reason: result.reason, next: FINAL_NEXT };
}
