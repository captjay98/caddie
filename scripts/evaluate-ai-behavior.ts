#!/usr/bin/env bun
/**
 * R04 AI behavior evaluation harness.
 *
 * DRY-RUN by default: runs the DETERMINISTIC rubric cases from
 * tests/acceptance/ai-behavior-cases.json with NO model and NO network —
 * hygiene (response-hygiene.ts) and capability honesty (coordinator-context
 * capabilityReport). This is the local gate the packet verifies.
 *
 * LIVE mode (model comparison across routes) is DELIBERATELY GATED: it refuses
 * unless CADDIE_LIVE_AUTHORIZED=1 AND a provider key is present, and even then
 * records model/version/receipts/time/spend — it is NOT run in this packet and
 * needs a separate bounded authorization (plan §5 "Model evaluation"). The
 * harness never fakes a model result.
 *
 * Usage:
 *   bun run scripts/evaluate-ai-behavior.ts            # dry-run deterministic
 *   bun run scripts/evaluate-ai-behavior.ts --live     # refuses w/o authorization
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeAssistantText } from '../apps/app/src/client/conversation/response-hygiene.ts';
import { capabilityReport, type CapabilitySignals } from '../apps/app/src/server/coordinator-context.ts';

const REPO = join(import.meta.dir, '..');
const CASES = join(REPO, 'tests', 'acceptance', 'ai-behavior-cases.json');

interface DeterministicCase {
	id: string;
	rubric: string;
	input?: string;
	expectStrippedContains?: string;
	expectVisible?: string;
	signals?: CapabilitySignals;
	expectCapability?: { id: string; enabled: boolean };
}

interface CaseFile {
	version: string;
	deterministic: DeterministicCase[];
	model: { id: string; rubric: string }[];
}

export interface CaseResult {
	id: string;
	passed: boolean;
	detail: string;
}

/** Judge one deterministic case with no model/network. Exported for the test. */
export function judgeDeterministic(c: DeterministicCase): CaseResult {
	if (c.input !== undefined) {
		const result = sanitizeAssistantText(c.input);
		if (c.expectStrippedContains && !result.stripped.includes(c.expectStrippedContains)) {
			return { id: c.id, passed: false, detail: `expected to strip ${c.expectStrippedContains}, stripped [${result.stripped.join(',')}]` };
		}
		if (c.expectVisible !== undefined && result.text !== c.expectVisible) {
			return { id: c.id, passed: false, detail: `visible text mismatch: ${JSON.stringify(result.text)} !== ${JSON.stringify(c.expectVisible)}` };
		}
		return { id: c.id, passed: true, detail: 'hygiene rubric met' };
	}
	if (c.signals && c.expectCapability) {
		const report = capabilityReport(c.signals);
		const cap = report.find((r) => r.id === c.expectCapability!.id);
		if (!cap) return { id: c.id, passed: false, detail: `no capability ${c.expectCapability.id}` };
		if (cap.enabled !== c.expectCapability.enabled) {
			return { id: c.id, passed: false, detail: `capability ${cap.id} enabled=${cap.enabled}, expected ${c.expectCapability.enabled}` };
		}
		return { id: c.id, passed: true, detail: 'capability honesty rubric met' };
	}
	return { id: c.id, passed: false, detail: 'unrecognized case shape' };
}

export function loadCases(): CaseFile {
	return JSON.parse(readFileSync(CASES, 'utf8')) as CaseFile;
}

export function runDryRun(): { results: CaseResult[]; allPassed: boolean } {
	const cases = loadCases();
	const results = cases.deterministic.map(judgeDeterministic);
	return { results, allPassed: results.every((r) => r.passed) };
}

async function main() {
	const live = process.argv.includes('--live');
	if (live) {
		const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';
		const hasKey = Boolean(process.env.NEBIUS_API_KEY);
		if (!authorized || !hasKey) {
			console.error('BLOCKED: live model evaluation needs CADDIE_LIVE_AUTHORIZED=1 and a provider key.');
			console.error('No model call was made. This packet does not run paid comparison.');
			process.exit(2);
		}
		console.error('BLOCKED: live comparison is intentionally not implemented in this packet.');
		console.error('It requires a separate bounded authorization (plan §5). No model call was made.');
		process.exit(2);
	}
	const { results, allPassed } = runDryRun();
	for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  — ${r.detail}`);
	console.log(`\n${results.filter((r) => r.passed).length}/${results.length} deterministic cases passed (DRY-RUN, no model/network).`);
	process.exit(allPassed ? 0 : 1);
}

if (import.meta.main) void main();
