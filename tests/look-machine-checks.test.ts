/**
 * Machine checks instead of an AI reviewer for the screens (owner 2026-10-29).
 * The merged look step's structural rules, the rendered measurements' mapping,
 * and the edit-time checks in the build. LOCAL VERIFIED: pure functions and a
 * fake sandbox driver; no model or browser is simulated as a pass.
 */
import { describe, expect, test } from 'bun:test';
import { CANONICAL_LOOKS_PROPOSAL, CANONICAL_LOOK_FEATURES, checksLintIssues, journeyLintIssues, LOOKS_BLOCK_GUIDE, lookProposalIssues, mockHtmlIssues, parseLooks, type AcceptanceJourneys } from '@caddie/contracts';
import { measureLooks, type DesignAuditPort } from '../apps/app/src/server/design-audit.ts';
import { checkFailureSignature, noteCheckFailure } from '../apps/app/src/server/repeat-failures.ts';
import { makeWriteSandboxFile, type SandboxToolDeps } from '../apps/app/src/agents/tools.ts';

const features = CANONICAL_LOOK_FEATURES.map((feature) => ({ id: feature.id, doneWhen: [...feature.doneWhen] }));

describe('browser checks that can never pass are refused when the design is saved (EggOps, 2026-10-30)', () => {
	const manifest = (criteria: AcceptanceJourneys['criteria']): AcceptanceJourneys => ({ version: 1, criteria, states: [{ title: 'Today', steps: [{ kind: 'open', path: '/' }] }] });
	const open = { kind: 'open', path: '/farm' } as const;
	const signIn = { kind: 'actor', user: 'a' } as const;
	test('pressing Save before anything is typed is refused (EggOps tip checks)', () => {
		const issues = journeyLintIssues(manifest([
			{ featureId: 'odd-day-tip', text: 'When no tip can be produced, a plain message with a Try again button appears', steps: [open, signIn, { kind: 'fault', path: '/api/tip', mode: 'fail' }, { kind: 'click', name: "Save today's count" }, { kind: 'expect', text: 'Try again', visible: true }] },
			{ featureId: 'odd-day-tip', text: 'Saving shows a tip', steps: [open, signIn, { kind: 'fill', label: 'Total eggs', value: '140' }, { kind: 'click', name: "Save today's count" }, { kind: 'expect', text: 'tip', visible: true }] },
			{ featureId: 'flock', text: 'Adding a flock shows it', steps: [open, signIn, { kind: 'click', name: 'Add flock' }, { kind: 'fill', label: 'Flock name', value: 'Pen 1' }, { kind: 'click', name: 'Save' }, { kind: 'expect', text: 'Pen 1', visible: true }] },
		]));
		expect(issues).toHaveLength(1);
		expect(issues[0]).toContain('criteria[0] (odd-day-tip) step 4 presses "Save today\'s count" before anything is typed');
	});
	test('the two EggOps checks that burned repair rounds are named, with the fix', () => {
		const issues = journeyLintIssues(manifest([
			{ featureId: 'see-days', text: "Tapping a day opens that day's numbers and its tip", steps: [open, signIn, { kind: 'click', name: 'See all days' }, { kind: 'click', name: '205' }, { kind: 'expect', text: 'tip', visible: true }] },
			{ featureId: 'odd-day-tip', text: "After a reload the same day shows its stored tip unchanged, and 'Look again' replaces it with a fresh answer", steps: [open, signIn, { kind: 'click', name: "Save today's count" }, { kind: 'reload' }, { kind: 'click', name: 'Look again' }, { kind: 'expect', text: '205', visible: true }] },
		]));
		expect(issues).toHaveLength(3);
		expect(issues[0]).toContain('criteria[0] (see-days) step 4 clicks "205", a number, not a button label');
		expect(issues[1]).toContain('criteria[1] (odd-day-tip) step 3 presses "Save today\'s count" before anything is typed');
		expect(issues[2]).toContain('criteria[1] (odd-day-tip) step 6 expects "205", but this check types nothing');
		expect(issues[2]).toContain('starts on an empty app');
	});
	test('sound checks pass: typed values, computed results, numbers the criterion promises, absence checks', () => {
		expect(journeyLintIssues(manifest([
			{ featureId: 'log-eggs', text: 'Entering 4 crates and 20 loose eggs shows 140 eggs', steps: [open, signIn, { kind: 'fill', label: 'Crates', value: '4' }, { kind: 'click', name: 'Save' }, { kind: 'expect', text: '140 eggs', visible: true }] },
			{ featureId: 'feed-log', text: 'Entering 5 bags at a price per bag shows what was spent', steps: [open, signIn, { kind: 'fill', label: 'Bags', value: '5' }, { kind: 'fill', label: 'Price per bag', value: '6500' }, { kind: 'expect', text: '32,500', visible: true }] },
			{ featureId: 'start-farm', text: "Tapping 'Begin with an example week' adds seven days with totals around 205 eggs", steps: [open, signIn, { kind: 'click', name: 'Begin with an example week' }, { kind: 'expect', text: '205', visible: true }] },
			{ featureId: 'isolation', text: 'A different person sees no flocks', steps: [open, { kind: 'actor', user: 'b' }, { kind: 'expect', text: 'Pen 12', visible: false }] },
			{ featureId: 'marker', text: 'A saved note comes back', steps: [open, { kind: 'fill', label: 'Note', value: '{{marker}}' }, { kind: 'click', name: 'Save' }, { kind: 'expect', text: '{{marker}}', visible: true }] },
		]))).toEqual([]);
	});
	test('the designer guide example passes, and the save check reads the manifest out of the proposal', () => {
		expect(checksLintIssues(CANONICAL_LOOKS_PROPOSAL)).toEqual([]);
		const bad = CANONICAL_LOOKS_PROPOSAL.replace(/"kind":"click","name":"[^"]+"/, '"kind":"click","name":"205"');
		expect(bad).not.toBe(CANONICAL_LOOKS_PROPOSAL);
		expect(checksLintIssues(bad).join('\n')).toContain('clicks "205"');
	});
});

describe('the merged look step is checked in code', () => {
	test('the example in the designer guide passes every check, and the guide carries it', () => {
		expect(lookProposalIssues(CANONICAL_LOOKS_PROPOSAL, { features })).toEqual([]);
		expect(LOOKS_BLOCK_GUIDE).toContain(CANONICAL_LOOKS_PROPOSAL);
	});

	test('a proposal that misses the rules is refused with every fix at once', () => {
		const parsed = parseLooks(CANONICAL_LOOKS_PROPOSAL);
		if (!parsed.ok) throw new Error(parsed.error);
		const block = JSON.parse(/```caddie-looks\n([\s\S]*?)\n```/.exec(CANONICAL_LOOKS_PROPOSAL)![1]!);
		block.looks = block.looks.slice(0, 2);
		block.looks[1].screen.title = 'Home';
		block.looks[0].screen.html = block.looks[0].screen.html.replace('<span style', '<i/><span style').replace('var(--primary)', '#1F7A3A');
		block.inventory = [{ screen: 'Today', what: 'The day', features: ['log-day', 'ghost-feature'] }];
		const body = `\`\`\`caddie-looks\n${JSON.stringify(block)}\n\`\`\``;
		const issues = lookProposalIssues(body, { features }).join('\n');
		expect(issues).toContain('exactly 3 looks');
		expect(issues).toContain('same title');
		expect(issues).toContain('self-closes <i/>');
		expect(issues).toContain('hard-codes #1F7A3A');
		expect(issues).toContain('ghost-feature');
		expect(issues).toContain('leaves out feature-alert'.replace('feature-alert', 'feed-alert'));
		expect(issues).toContain('caddie-checks');
	});

	test('the checks must copy every approved doneWhen exactly', () => {
		const body = CANONICAL_LOOKS_PROPOSAL.replace('With 2 days of feed left', 'When feed is low');
		expect(lookProposalIssues(body, { features }).join('\n')).toContain('feed-alert "With 2 days of feed left');
	});

	test('a wrong browser-check step is named once, with its exact shape and where it is (Farm Ops, 2026-10-29)', () => {
		const body = CANONICAL_LOOKS_PROPOSAL.replace('{"kind":"restart"}', '{"kind":"actor","value":"owner"}').replace('{"kind":"click","name":"Save"},{"kind":"expect","text":"Feed runs out"}', '{"kind":"click","name":"Save"},{"kind":"actor","value":"worker"},{"kind":"expect","text":"Feed runs out"}');
		const issues = lookProposalIssues(body, { features });
		expect(issues).toHaveLength(1);
		expect(issues[0]).toContain('every "actor" step must be exactly {"kind":"actor","user":"a"}');
		expect(issues[0]).toContain('fix 2 places: criteria[0] step 5, criteria[1] step 5');
		expect(LOOKS_BLOCK_GUIDE).toContain('{"kind":"actor","user":"a"}');
	});

	test('a sketch is not a screen', () => {
		expect(mockHtmlIssues('<main><h1>Today</h1><button>Go</button></main>', 'look "a" screen').join(' ')).toContain('only 3 elements');
		expect(mockHtmlIssues('<main><p>x</p></main>', 'look "a" screen').join(' ')).toContain('no <button>');
		// Void elements and SVG shapes may self-close.
		expect(mockHtmlIssues('<main><img src="x"/><svg><path d="M0 0"/></svg>' + '<p>a</p>'.repeat(12) + '<button>Go</button></main>', 's')).toEqual([]);
	});
});

describe('rendered measurements become findings the designer can act on', () => {
	const parsed = parseLooks(CANONICAL_LOOKS_PROPOSAL);
	if (!parsed.ok) throw new Error(parsed.error);
	test('every look is measured, and each measured problem is a blocking finding naming the look', async () => {
		let seen: string[] = [];
		const port: DesignAuditPort = {
			async audit(states) {
				seen = states.map((state) => state.id);
				return [
					{ stateId: 'field', viewport: 'phone', contrast: ['"Pen A" is hard to read: contrast 2.1:1, needs 4.5:1'], targets: ['"Save" is 30×30px; make it at least 44×44'], overflow: true },
					{ stateId: 'list', viewport: 'phone', contrast: [], targets: [], overflow: false },
				];
			},
		};
		const findings = await measureLooks(CANONICAL_LOOKS_PROPOSAL, parsed.set, port);
		expect(seen).toEqual(['field', 'list', 'number']);
		expect(findings.map((row) => `${row.severity}:${row.criterion}`)).toEqual(['blocking:contrast', 'blocking:tap size', 'blocking:fits the screen']);
		expect(findings[0]!.detail).toStartWith('Field-ready (phone)');
	});
	test('no screen checker means nothing was measured — advisory, never a measured pass', async () => {
		const findings = await measureLooks(CANONICAL_LOOKS_PROPOSAL, parsed.set, undefined);
		expect(findings).toEqual([{ severity: 'advisory', criterion: 'measured on screen', detail: expect.stringContaining('were not measured') }]);
	});
});

describe('edit-time checks in the build', () => {
	function fakeSandbox(parseOk: (path: string, content: string) => boolean) {
		const files = new Map<string, string>([['src/App.tsx', 'export const App = () => <main>ok</main>;\n']]);
		const commands: string[] = [];
		const driver: SandboxToolDeps = {
			async readFile({ path }) { const body = files.get(path); if (body === undefined) throw new Error('missing'); return body; },
			async writeFile({ path, content }) { files.set(path, content); },
			async execute({ command }) {
				commands.push(command);
				const rm = /^rm -f '(.+)'$/.exec(command);
				if (rm) { files.delete(rm[1]!); return { remoteId: 'x', exitCode: 0 }; }
				const path = /--no-bundle '(.+?)'/.exec(command)![1]!;
				return parseOk(path, files.get(path) ?? '')
					? { remoteId: 'x', exitCode: 0, stdout: 'Transpiled file in 3ms' }
					: { remoteId: 'x', exitCode: 1, stdout: `1 | <div>hi</span>\n                ^\nerror: Expected closing JSX tag to match opening tag "<div>"\n    at /app/${path}:1:52` };
			},
		};
		return { files, commands, driver };
	}
	const run = (tool: ReturnType<typeof makeWriteSandboxFile>, path: string, content: string, id: string) =>
		(tool as unknown as { run(ctx: unknown): Promise<{ output: string }> }).run({ data: { sessionId: 's', path, content }, toolCallId: id, signal: undefined });

	test('a write that parses is kept', async () => {
		const box = fakeSandbox(() => true);
		const tool = makeWriteSandboxFile({ driver: box.driver, sessionId: 's1' });
		expect((await run(tool, 'src/App.tsx', 'export const App = () => <main>new</main>;\n', 'a')).output).toBe('wrote src/App.tsx');
		expect(box.files.get('src/App.tsx')).toContain('new');
		expect(box.commands[0]).toContain("bun build --no-bundle 'src/App.tsx'");
	});

	test('a broken edit is put back straight away, and the same error twice asks for a different approach', async () => {
		const box = fakeSandbox((_path, content) => !content.includes('</span>'));
		const tool = makeWriteSandboxFile({ driver: box.driver, sessionId: 's2' });
		const before = box.files.get('src/App.tsx');
		const first = run(tool, 'src/App.tsx', 'export const App = () => <div>hi</span>;\n', 'b1');
		await expect(first).rejects.toThrow('EDIT_REJECTED: src/App.tsx does not parse');
		await expect(run(tool, 'src/App.tsx', 'export const App = () => <div>hi</span>;\n', 'b2')).rejects.toThrow('SAME error as your last attempt');
		expect(box.files.get('src/App.tsx')).toBe(before);
		// A new file that does not parse is removed, not left half-written.
		await expect(run(tool, 'src/New.tsx', '<div></span>', 'b3')).rejects.toThrow('the new file was removed');
		expect(box.files.has('src/New.tsx')).toBe(false);
	});

	test('a write that parses but imports a missing export is kept and reported, and a repeat asks for a fix', async () => {
		const box = fakeSandbox(() => true);
		const unresolved = { remoteId: 'x', exitCode: 0, stdout: `Transpiled file in 3ms\n::caddie-unresolved::\n1 | import { b } from "./lib.ts";\nerror: No matching export in "src/lib.ts" for import "b"\n    at /app/src/App.tsx:1:10` };
		const execute = box.driver.execute;
		box.driver.execute = async (input) => {
			if (!box.files.get('src/App.tsx')?.includes('{ b }')) return execute(input);
			box.commands.push(input.command);
			return unresolved;
		};
		const tool = makeWriteSandboxFile({ driver: box.driver, sessionId: 's4' });
		const first = await run(tool, 'src/App.tsx', 'import { b } from "./lib.ts";\nexport const App = () => <main>{b}</main>;\n', 'd1');
		expect(first.output).toContain('wrote src/App.tsx (kept)');
		expect(first.output).toContain('No matching export in "src/lib.ts" for import "b"');
		expect(box.files.get('src/App.tsx')).toContain('{ b }');
		expect((await run(tool, 'src/App.tsx', 'import { b } from "./lib.ts";\nexport const App = () => <main>{b}!</main>;\n', 'd2')).output).toContain('Same problem as your last write');
		expect(box.commands[0]).toContain("--target=bun --packages=external");
	});

	test('invalid JSON is refused before it is written; non-source files are not parsed', async () => {
		const box = fakeSandbox(() => true);
		const tool = makeWriteSandboxFile({ driver: box.driver, sessionId: 's3' });
		await expect(run(tool, 'package.json', '{"name":', 'c1')).rejects.toThrow('is not valid JSON');
		expect(box.files.has('package.json')).toBe(false);
		await run(tool, 'src/styles.css', 'main{color:var(--text)}', 'c2');
		expect(box.commands).toEqual([]);
	});

	test('a repeated run_checks failure is recognised even when positions and timings move', () => {
		const a = checkFailureSignature('src/App.test.tsx:\n(fail) logs the day [12.3ms]\nerror: expect(received).toBe(expected) at src/App.test.tsx:14:7');
		const b = checkFailureSignature('src/App.test.tsx:\n(fail) logs the day [40.1ms]\nerror: expect(received).toBe(expected) at src/App.test.tsx:15:9');
		expect(a).toBe(b);
		expect(noteCheckFailure('run:feature', a)).toBe(1);
		expect(noteCheckFailure('run:feature', b)).toBe(2);
		expect(noteCheckFailure('run:feature', 'something else')).toBe(1);
	});
});
