/**
 * Lane 8, item 2 — the pure parts of the two-app-user browser check.
 *
 * Two Caddie accounts are the WRONG design for "B can't see A's record": a
 * second Caddie account cannot even open the first account's preview, so the
 * isolation would pass for the wrong reason. Instead the check uses two users
 * OF THE BUILT APP, inside the preview of the run's project, both driven from
 * the owner's ONE Caddie session. Each signs in through the generated app's own
 * email-code sign-in (request a code for a@campaign.test / b@campaign.test, read
 * it from the project's test inbox, enter it).
 *
 * This module is the data-only parts, kept out of the browser flow so they are
 * unit-tested against the REAL shapes:
 *   - `pickRecordTarget(block)` finds the first PERSON-owned table that has a
 *     create route AND a screen showing it — the record the check exercises.
 *     An app with no such table is "not applicable" (never "passed").
 *   - `readInboxCode(inbox, email)` reads the newest sign-in code for an email
 *     from the test-inbox shape the route returns ({ messages:[{to,code,
 *     createdAt}], emails:[…] }; see apps/app/src/client/project/TestInbox.tsx).
 *   - `firstTextField(route)` is the create form's first text field — where the
 *     unique marker is typed (mirrors contract-files step 8, which finds a
 *     record's text through the first text field).
 */
import {
	parseArchitectureBlock,
	type ArchitectureBlock,
	type ArchitectureRoute,
	type ArchitectureScreen,
	type ArchitectureTable,
} from '@caddie/contracts';

/** The app@test email addresses the two app users sign in with (plan item 2). */
export const APP_USER_A_EMAIL = 'a@campaign.test';
export const APP_USER_B_EMAIL = 'b@campaign.test';

/** The record the browser check will create, read back and check for isolation. */
export interface RecordTarget {
	table: ArchitectureTable;
	/** The create route (op 'create') for the table. */
	createRoute: ArchitectureRoute;
	/** A screen whose `shows` includes the table. */
	screen: ArchitectureScreen;
	/** The first text request-field of the create route — where the marker goes. */
	markerField: string;
}

/** The outcome of choosing a target: a target, or "not applicable" with a reason. */
export type TargetChoice =
	| { applicable: true; target: RecordTarget }
	| { applicable: false; reason: string };

/** The first text-typed request field of a create route (the marker field). */
export function firstTextField(route: ArchitectureRoute): string | null {
	const field = route.request.find((f) => f.type === 'text');
	return field ? field.name : null;
}

/**
 * Pick the record the check exercises: the FIRST person-owned table that has a
 * create route and a screen showing it, and whose create route has a text field
 * to carry the marker. Tables are considered in declaration order, so the
 * choice is deterministic. Returns "not applicable" (never a pass) when no such
 * table exists — exactly the plan's rule for an app with no person-owned table
 * that has a screen.
 */
export function pickRecordTarget(block: ArchitectureBlock): TargetChoice {
	const personTables = block.tables.filter((t) => t.owner === 'person');
	if (personTables.length === 0) {
		return { applicable: false, reason: 'the app declares no person-owned table, so there is no private record to check' };
	}
	for (const table of personTables) {
		const createRoute = block.routes.find((r) => r.table === table.name && r.op === 'create');
		if (!createRoute) continue;
		const screen = block.screens.find((s) => s.shows.includes(table.name));
		if (!screen) continue;
		const markerField = firstTextField(createRoute);
		if (!markerField) continue;
		return { applicable: true, target: { table, createRoute, screen, markerField } };
	}
	return {
		applicable: false,
		reason: 'no person-owned table has both a create route (with a text field) and a screen showing it',
	};
}

/** Choose the target from a DESIGN document (the /workflow design doc). */
export function pickRecordTargetFromDesign(designMarkdown: string): TargetChoice {
	const parsed = parseArchitectureBlock(designMarkdown);
	if (!parsed.ok) return { applicable: false, reason: `could not read the design's architecture block: ${parsed.error}` };
	return pickRecordTarget(parsed.block);
}

/** The test-inbox shape the route returns (apps/app TestInbox.tsx). */
export interface TestInbox {
	messages: Array<{ to: string; code: string; createdAt: string }>;
	emails?: Array<{ to: string; subject: string; text: string; template: string | null; createdAt: string }>;
}

/**
 * Read the NEWEST sign-in code for `email` from the test inbox. The inbox holds
 * every code the app sent; a run requests a fresh code immediately before, so
 * the newest matching message is the one just sent. Returns null while none has
 * arrived yet, so the browser flow can poll. Matching is case-insensitive on
 * the address, mirroring the app's own lower-casing of emails.
 */
/** A test-inbox message's identity (two sends of the same code differ by time). */
export function inboxMessageKey(message: { code: string; createdAt: string }): string {
	return `${message.createdAt}|${message.code}`;
}

/** The keys of every message for `email` now in the inbox (the "already there" set). */
export function inboxKeysFor(inbox: TestInbox, email: string): Set<string> {
	const want = email.trim().toLowerCase();
	return new Set((inbox.messages ?? []).filter((m) => m.to.trim().toLowerCase() === want).map(inboxMessageKey));
}

export function readInboxCode(inbox: TestInbox, email: string, exclude: ReadonlySet<string> = new Set()): string | null {
	const want = email.trim().toLowerCase();
	let newest: { code: string; createdAt: string } | null = null;
	for (const message of inbox.messages ?? []) {
		if (message.to.trim().toLowerCase() !== want) continue;
		if (exclude.has(inboxMessageKey(message))) continue;
		if (!newest || message.createdAt > newest.createdAt) newest = { code: message.code, createdAt: message.createdAt };
	}
	return newest ? newest.code : null;
}
