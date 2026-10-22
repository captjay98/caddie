import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * B06 — in-chat spend approval card
 * (docs/design/2026-10-10-v2/PACKETS.md).
 *
 * Core invariants, proven against the shipped source:
 *   1. The coordinator emits a TYPED data part carrying the server approval
 *      id (useDataWriter with a valibot schema) — chat prose is never the
 *      carrier, and the part carries NO model-chosen spend number (part A §6).
 *   2. Allow / Not now call the APPROVALS API (server read → server decide);
 *      card state comes from the server response.
 *   3. Card text can never approve anything without a server approval id:
 *      an unparsable payload renders a fault, not an actionable card.
 */

const REPO_ROOT = join(import.meta.dir, '..');

const coordinatorSrc = readFileSync(
	join(REPO_ROOT, 'apps/app/src/agents/coordinator.ts'),
	'utf8',
);
const cardSrc = readFileSync(
	join(REPO_ROOT, 'apps/app/src/client/conversation/ApprovalCard.tsx'),
	'utf8',
);
const channelSrc = readFileSync(
	join(REPO_ROOT, 'apps/app/src/client/conversation/Channel.tsx'),
	'utf8',
);

describe('B06: in-chat approval card', () => {
	test('the coordinator emits a typed approval data part with the server approval id and no model-chosen number', () => {
		// The data writer is schema-validated and named 'approvalCard'.
		expect(coordinatorSrc).toContain("useDataWriter('approvalCard'");
		expect(coordinatorSrc).toMatch(/approvalId:\s*v\.string\(\)/);
		// The write happens after the server issued the approval id — the id
		// comes from the request bridge, never invented in the agent.
		expect(coordinatorSrc).toMatch(/requestApproval[\s\S]{0,600}?writeApprovalCard\(\{[\s\S]{0,160}?approvalId:\s*approval\.id/);
		// The tool refuses to fabricate: no bridge, no card.
		expect(coordinatorSrc).toContain("if (!bridge) return 'approvals are not available in this run'");
		// Part A §6: the card payload drops the model-chosen cap/currency.
		expect(coordinatorSrc).not.toContain('capMinorUnits');
		expect(coordinatorSrc).not.toMatch(/writeApprovalCard\(\{[\s\S]{0,200}?currency:/);
	});

	test('the card decides through the approvals API: server read, then server decide', () => {
		// The card reads the approval's real intent from the server first.
		expect(cardSrc).toContain('/api/approvals/');
		// Then posts the decision with THAT intent (not chat text).
		expect(cardSrc).toMatch(/postJson[\s\S]{0,200}?intent:\s*\{[\s\S]{0,300}?projectId:\s*approval\.projectId/);
		// Card state follows the server response.
		expect(cardSrc).toMatch(/setStatus\(result\.approval\.status\)/);
	});

	test('card text can never approve anything without a server approval id', () => {
		// The client schema requires approvalId: a payload without it fails
		// validation and renders a fault, never an actionable card.
		expect(channelSrc).toContain("part.type === 'data-approvalCard'");
		expect(channelSrc).toContain('ApprovalCardData');
		expect(channelSrc).toContain('approval-payload-fault');
		// The schema itself hard-requires the id.
		expect(cardSrc).toMatch(/approvalId:\s*v\.string\(\)/);
	});

	test('the card shows NO model-chosen number — only the approval and plain-words actions (part A §6)', () => {
		// Part A §6: the spending limit the user sees is the build's own D4 limit,
		// shown on the BUILD card. This approval card must not render a
		// model-chosen cap: the "Spending limit" panel and its "Uses up to $X" /
		// "ask before anything costs money" copy are gone, and the payload no
		// longer carries capMinorUnits/currency.
		expect(cardSrc).not.toContain('Spending limit');
		expect(cardSrc).not.toContain('Uses up to');
		expect(cardSrc).not.toContain('Caddie will ask before anything costs money');
		expect(cardSrc).not.toContain('capMinorUnits');
		expect(cardSrc).not.toContain('currency');
		// The plain-words actions remain.
		expect(cardSrc).toContain('Allow');
		expect(cardSrc).toContain('Not now');
		// The approval's own description is still shown.
		expect(cardSrc).toContain('approval-what');
	});
});
