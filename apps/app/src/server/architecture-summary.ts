/**
 * "How your app works" in plain sentences (plan part B — the summary function).
 *
 * The Design review screen (lane 6) shows the approved `caddie-architecture`
 * block to a non-technical person. This turns the block into short, plain
 * sentences grouped into the sections part B names:
 *
 *   what it saves        — each kind of record and who it belongs to
 *   who can do what      — the access on the app's actions, in plain words
 *   sign-in              — whether people sign in
 *   outside services     — the keys the owner must supply
 *   AI                   — the AI uses, and which look at photos
 *   test-mode features   — payments, emails and jobs, each labelled test mode
 *
 * Pure: a block in, sentences out, no I/O. It never invents detail the block
 * does not carry; a section the block leaves empty is omitted (never shown as
 * a bare heading — a lesson from the Caddie card work). Team-mode only.
 */

import type { Access, ArchitectureBlock, ArchitectureRoute, TableOwner } from '@caddie/contracts';
import { teamRoleOf } from '@caddie/contracts';

/** One section of the summary: a heading and its plain lines (never empty). */
export interface SummarySection {
	key: 'saves' | 'access' | 'sign-in' | 'services' | 'ai' | 'test-mode';
	heading: string;
	lines: string[];
}

/** Plain words for who owns a kind of record. */
function ownerPhrase(owner: TableOwner): string {
	switch (owner) {
		case 'person':
			return 'private to each person';
		case 'team':
			return "shared within a team";
		case 'shared':
			return 'shared by everyone signed in';
		case 'public':
			return 'open to everyone';
	}
}

/** Plain words for who may do a thing (a route's access). */
export function accessPhrase(access: Access): string {
	const role = teamRoleOf(access);
	if (role) return `a team's ${role}`;
	switch (access) {
		case 'public':
			return 'anyone';
		case 'signed-in':
			return 'anyone signed in';
		case 'person':
			return 'each person, for their own records';
		case 'team':
			return "a team's members";
		case 'admin':
			return "the app's admins";
		case 'job':
			return "Caddie's scheduled run";
		default:
			return access;
	}
}

/** A verb for a route's op, so "who can do what" reads as an action. */
function opVerb(op: ArchitectureRoute['op']): string {
	switch (op) {
		case 'create':
			return 'add';
		case 'read':
			return 'see';
		case 'list':
			return 'list';
		case 'update':
			return 'change';
		case 'delete':
			return 'remove';
		case 'action':
			return 'do';
	}
}

/**
 * Turn the block into grouped plain sentences. Returns only the sections the
 * block actually populates, each with at least one line.
 */
export function summariseArchitecture(block: ArchitectureBlock): SummarySection[] {
	const sections: SummarySection[] = [];
	const push = (section: SummarySection) => {
		if (section.lines.length > 0) sections.push(section);
	};

	// What it saves — each kind of record and who it belongs to.
	push({
		key: 'saves',
		heading: 'What it saves',
		lines: block.tables.map((t) => `${t.plain} — ${ownerPhrase(t.owner)}.`),
	});

	// Who can do what — group the app's actions by who may do them.
	const byAccess = new Map<string, string[]>();
	for (const r of block.routes) {
		const who = accessPhrase(r.access as Access);
		const what = r.table ? `${opVerb(r.op)} ${tablePlain(block, r.table)}` : r.plain.toLowerCase();
		if (!byAccess.has(who)) byAccess.set(who, []);
		const list = byAccess.get(who)!;
		if (!list.includes(what)) list.push(what);
	}
	push({
		key: 'access',
		heading: 'Who can do what',
		lines: [...byAccess.entries()].map(([who, whats]) => `${capitalise(who)} can ${joinList(whats)}.`),
	});

	// Sign-in.
	push({
		key: 'sign-in',
		heading: 'Signing in',
		lines: [
			block.signIn === 'required'
				? 'People sign in with a code emailed to them.'
				: block.signIn === 'optional'
					? 'People can sign in with an emailed code, but do not have to.'
					: 'Nobody signs in; the app is open.',
		],
	});

	// Outside services — the keys the owner must supply.
	push({
		key: 'services',
		heading: 'Outside services',
		lines: block.services.map((s) => `${capitalise(s.plain)} (the owner supplies a key).`),
	});

	// AI — each AI use, and which look at photos.
	push({
		key: 'ai',
		heading: 'AI',
		lines: block.ai.map((a) => `${capitalise(a.plain)}${a.images ? ' (it can look at photos)' : ''}.`),
	});

	// Test-mode features — payments, emails and jobs, each labelled test mode.
	const testLines: string[] = [];
	if (block.payments) {
		const plans = block.payments.plans.map((p) => p.plain);
		testLines.push(`Paid plans (${joinList(plans)}) — test mode, no money moves.`);
	}
	for (const e of block.emails) testLines.push(`${capitalise(e.plain)} — test mode, it lands in the test inbox.`);
	for (const j of block.jobs) testLines.push(`${capitalise(j.plain)} — test mode, you run it with a button.`);
	push({ key: 'test-mode', heading: 'Test-mode features', lines: testLines });

	return sections;
}

/** The whole summary as one plain-text block, sections separated by blank lines. */
export function summariseArchitectureText(block: ArchitectureBlock): string {
	return summariseArchitecture(block)
		.map((s) => `${s.heading}\n${s.lines.map((l) => `- ${l}`).join('\n')}`)
		.join('\n\n');
}

// --- helpers -----------------------------------------------------------------

function tablePlain(block: ArchitectureBlock, tableName: string): string {
	const table = block.tables.find((t) => t.name === tableName);
	return (table?.plain ?? tableName).toLowerCase();
}

function capitalise(s: string): string {
	return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** "a, b and c" from a list of phrases. */
function joinList(items: string[]): string {
	if (items.length <= 1) return items.join('');
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
