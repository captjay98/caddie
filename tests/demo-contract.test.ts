import { describe, expect, test } from 'bun:test';
import { parseDemoContract } from '../packages/contracts/src/demo-contract.ts';

/**
 * The demo-contract gate exists because FarmLog AI's PRD was comprehensive and
 * still planned a toy: Ollama locally, mock prices, rule-based alerts. These
 * tests pin the boundary the host enforces before a PRD revision is saved.
 */

const CONTRACT = `## Demo contract

**One-line pitch:** A farmer speaks a symptom and gets a grounded herd diagnosis in seconds.
**Demo path (3 minutes):**
1. Say "cow 14 is limping and off feed" on the record screen.
2. The AI returns three ranked causes with the evidence it used.
3. Reload the page; the case is still in the herd timeline.
**Real integration:** Caddie's AI (\`c.env.CADDIE.ai\` in \`src/server.ts\`, tier "super") receives the note plus the animal's recent logs and returns ranked causes.
**Mocks:** None.
**Why this wins:** It turns a speech note into a triage decision a vet can check, instead of another CRUD log.`;

const PRD = `# Herd voice triage

${CONTRACT}

\`\`\`caddie-features
[{"id":"voice-case","title":"Record a case by voice","doneWhen":["A spoken note is saved to the herd timeline"]}]
\`\`\`
`;

describe('demo contract', () => {
	test('a real demo contract parses and keeps the feature block out of the prose', () => {
		const result = parseDemoContract(PRD);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.contract.pitch).toContain('grounded herd diagnosis');
		expect(result.contract.demoPath).toHaveLength(3);
		expect(result.contract.demoPath[1]).toContain('ranked causes');
		expect(result.contract.integration).toContain('c.env.CADDIE.ai');
		expect(result.contract.mocks).toBe('None.');
		expect(result.contract.whyItWins).toContain('CRUD log');
		expect(result.contract.whyItWins).not.toContain('caddie-features');
	});

	test('a PRD with no demo contract is refused', () => {
		const result = parseDemoContract('# Farm log\n\nTables and endpoints, but no demo.');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('Demo contract');
	});

	test('every required label is enforced', () => {
		const result = parseDemoContract(CONTRACT.replace('**Mocks:** None.\n', ''));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('"Mocks:"');
	});

	test('a canned path with fewer than three numbered steps is refused', () => {
		const result = parseDemoContract(
			CONTRACT.replace(
				/1\. Say "cow 14 is limping and off feed" on the record screen\.\n2\. The AI returns three ranked causes with the evidence it used\.\n3\. Reload the page; the case is still in the herd timeline\./,
				'1. Open the dashboard.\n2. Point at a chart.',
			),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('at least 3 numbered steps');
	});

	test('a mock cannot be the real integration', () => {
		const result = parseDemoContract(
			CONTRACT.replace(
				'**Real integration:** Caddie\'s AI (`c.env.CADDIE.ai` in `src/server.ts`, tier "super") receives the note plus the animal\'s recent logs and returns ranked causes.',
				'**Real integration:** A mock AI JSON file with canned diagnoses.',
			),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('cannot be a mock');
	});

	test("Caddie's AI without a named tier is refused — the planner must pick fast or super", () => {
		const result = parseDemoContract(
			CONTRACT.replace('(`c.env.CADDIE.ai` in `src/server.ts`, tier "super")', '(`c.env.CADDIE.ai` in `src/server.ts`)'),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('no tier');
		expect(result.error).toContain('"fast"');
		expect(result.error).toContain('"super"');
	});

	test('a "None" integration with a real reason passes without a tier', () => {
		const localReal = CONTRACT.replace(
			'**Real integration:** Caddie\'s AI (`c.env.CADDIE.ai` in `src/server.ts`, tier "super") receives the note plus the animal\'s recent logs and returns ranked causes.',
			'**Real integration:** None — SQLite persistence and local math carry the demo; no outside service does.',
		);
		const result = parseDemoContract(localReal);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.contract.integration).toContain('no outside service');
	});

	test('placeholders are refused', () => {
		const result = parseDemoContract(
			CONTRACT.replace('**Why this wins:** It turns a speech note into a triage decision a vet can check, instead of another CRUD log.', '**Why this wins:** TBD'),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// TBD is both too short and a placeholder; the length message wins first.
		expect(result.error).toMatch(/Why this wins|placeholder/);
	});

	test('markdown heading labels are accepted as well as bold labels', () => {
		const headingStyle = CONTRACT.replace(/\*\*(.+?):\*\*/g, '### $1:').replace('### Demo path (3 minutes):', '### Demo path (3 minutes):');
		const result = parseDemoContract(headingStyle);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.contract.mocks).toBe('None.');
	});
});
