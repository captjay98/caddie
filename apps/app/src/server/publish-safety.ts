/**
 * Publish safety for the exact output (plan part G).
 *
 * Before a bundle goes live, this refuses it when:
 *   - the bundle (its browser code `js`/`css`, and its server code when it has
 *     one) carries a SAVED APP KEY or a key-shaped string — a secret the app
 *     should read from env, never ship to the browser;
 *   - IN TEAM MODE, that exact output's OWN verify receipts do not show the
 *     sign-in, second-person and restart contract checks green. The receipts
 *     are bound to the output id, so a green receipt on a DIFFERENT output
 *     never counts (part G: "bound to the output id").
 *
 * The check binds to the output being published: approval and checks name that
 * output's id, and nothing else.
 *
 * Kill switch: when `publishSafety` is `'off'`, the findings are still computed
 * and returned (for logging), but `refused` is false — the publish proceeds.
 * The call site logs the findings and does not block (plan part G, D6, §11).
 *
 * This module is PURE: it takes the bundle's code, the output id, the team-mode
 * flag, the switch value, and a lookup of that output's verify receipts. It
 * reaches no database and no network, so it is tested in isolation and the
 * publish call site (`server/publish.ts`) supplies the real receipts.
 */

/** The app-key name shape (mirrors APP_SECRET_NAME in app-secrets.ts). A bundle
 *  must not contain the VALUE of a saved key, nor a string shaped like one. */
const APP_KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Patterns that mark a string as a secret that must never reach the browser.
 * These are the shapes real provider keys take — deliberately broad, because a
 * false refusal is a blocked publish the owner can read and fix, while a missed
 * key is a leaked secret that cannot be taken back.
 */
const KEY_SHAPED: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp; readonly plain: string }> = [
	{ id: 'openai', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, plain: 'an OpenAI-style key (sk-…)' },
	{ id: 'stripe-secret', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/, plain: 'a Stripe secret key (sk_live_… / sk_test_…)' },
	{ id: 'stripe-restricted', pattern: /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/, plain: 'a Stripe restricted key (rk_live_… / rk_test_…)' },
	{ id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, plain: 'an AWS access key id (AKIA… / ASIA…)' },
	{ id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, plain: 'a GitHub token (ghp_… / gho_… / ghs_…)' },
	{ id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, plain: 'a Google API key (AIza…)' },
	{ id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, plain: 'a Slack token (xoxb-… / xoxp-…)' },
	{ id: 'private-key-block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, plain: 'a private key block' },
	{ id: 'bearer-jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, plain: 'a signed token (a JWT, eyJ…)' },
];

/** The contract checks part G requires green, bound to the output, in team mode. */
export const REQUIRED_TEAM_MODE_CHECKS = ['sign-in', 'second-person', 'restart'] as const;
export type RequiredTeamModeCheck = (typeof REQUIRED_TEAM_MODE_CHECKS)[number];

/**
 * One output's verify receipts for the team-mode contract checks. The publish
 * call site reads these from the store that holds the output's check results
 * (host-checks writes them), keyed by the output id; this module only reads the
 * green/red verdict per required check. `outputId` lets the call site prove the
 * receipts belong to the output being published, not another one.
 */
export interface OutputVerifyReceipts {
	/** The output these receipts belong to. Must equal the output being published. */
	readonly outputId: string;
	/** Per required check: true when that check ran and passed for this output. */
	readonly checks: Readonly<Record<RequiredTeamModeCheck, boolean>>;
}

export type SafetyFindingKind = 'saved-key' | 'key-shaped' | 'missing-receipt' | 'red-receipt' | 'wrong-output';

export interface SafetyFinding {
	readonly kind: SafetyFindingKind;
	/** A plain sentence the owner can act on. */
	readonly message: string;
	/** Where it was found: a bundle part, or a check name. */
	readonly where: string;
}

export interface PublishSafetyInput {
	/** The output being published — everything binds to this id. */
	readonly outputId: string;
	/** The bundle's browser code (dist/main.js) and styles (dist/main.css). */
	readonly js: string;
	readonly css: string;
	/** The bundle's server code, or null for a browser-only app. */
	readonly server: string | null;
	/** The owner's SAVED app-key names for this project (so their VALUES can be scanned for). */
	readonly savedKeyNames: readonly string[];
	/** The VALUES of the saved keys, when the call site can read them, so an exact value in the bundle is caught. */
	readonly savedKeyValues?: readonly string[];
	/** True when this project is a team-mode project. */
	readonly teamMode: boolean;
	/** The publish_safety switch: 'on' blocks on findings, 'off' logs only. */
	readonly publishSafety: 'on' | 'off';
	/** That output's own verify receipts (team mode only); null when none exist. */
	readonly receipts: OutputVerifyReceipts | null;
}

export interface PublishSafetyResult {
	/** True when the publish must be refused (findings AND the switch is on). */
	readonly refused: boolean;
	readonly findings: readonly SafetyFinding[];
	/** A single plain sentence for the owner, or null when nothing was found. */
	readonly message: string | null;
}

/** Find a saved app key's VALUE or a key-shaped string anywhere in the bundle's code. */
function scanForKeys(input: PublishSafetyInput): SafetyFinding[] {
	const findings: SafetyFinding[] = [];
	const parts: Array<{ where: string; text: string }> = [
		{ where: 'the browser code (dist/main.js)', text: input.js },
		{ where: 'the styles (dist/main.css)', text: input.css },
	];
	if (input.server !== null) parts.push({ where: 'the server code (dist/server.js)', text: input.server });

	for (const part of parts) {
		if (!part.text) continue;

		// 1. A saved key's exact value shipped in the bundle.
		for (const value of input.savedKeyValues ?? []) {
			// Only values long enough to be a real secret; a 1–3 char "value" is noise.
			if (value.length >= 8 && part.text.includes(value)) {
				findings.push({
					kind: 'saved-key',
					where: part.where,
					message: `${part.where} contains the value of one of this app's saved keys. A key must stay on the server (env), never ship to the browser.`,
				});
				break; // one finding per part is enough to refuse
			}
		}

		// 2. A key-shaped string (any provider's), even one not saved here.
		for (const shape of KEY_SHAPED) {
			if (shape.pattern.test(part.text)) {
				findings.push({
					kind: 'key-shaped',
					where: part.where,
					message: `${part.where} contains what looks like ${shape.plain}. Read keys from env on the server; never put one in the app's code.`,
				});
			}
		}
	}
	return findings;
}

/** In team mode, the output's own receipts must show the required checks green. */
function checkReceipts(input: PublishSafetyInput): SafetyFinding[] {
	const findings: SafetyFinding[] = [];
	if (!input.teamMode) return findings;

	if (input.receipts === null) {
		findings.push({
			kind: 'missing-receipt',
			where: 'verify receipts',
			message: "This app's checks haven't been recorded for this exact version. Run the checks on this version, then publish.",
		});
		return findings;
	}
	// The receipts must belong to the output being published — not another one.
	if (input.receipts.outputId !== input.outputId) {
		findings.push({
			kind: 'wrong-output',
			where: 'verify receipts',
			message: "The recorded checks are for a different version of this app. Run the checks on the version you are publishing.",
		});
		return findings;
	}
	for (const check of REQUIRED_TEAM_MODE_CHECKS) {
		if (input.receipts.checks[check] !== true) {
			findings.push({
				kind: 'red-receipt',
				where: check,
				message: checkFailureSentence(check),
			});
		}
	}
	return findings;
}

function checkFailureSentence(check: RequiredTeamModeCheck): string {
	switch (check) {
		case 'sign-in':
			return "The sign-in check isn't green for this version, so people's data might not be protected. Fix it and run the checks again before publishing.";
		case 'second-person':
			return "The privacy check (one person can't see another's data) isn't green for this version. Fix it and run the checks again before publishing.";
		case 'restart':
			return "The saved-data check (data is still there after the app restarts) isn't green for this version. Fix it and run the checks again before publishing.";
	}
}

/**
 * Run the publish safety check for one output. Pure: no database, no network.
 * Refuses only when there are findings AND `publishSafety` is `'on'`; when it
 * is `'off'` the findings come back for logging and `refused` is false.
 */
export function checkPublishSafety(input: PublishSafetyInput): PublishSafetyResult {
	const findings = [...scanForKeys(input), ...checkReceipts(input)];
	const refused = findings.length > 0 && input.publishSafety === 'on';
	const message =
		findings.length === 0
			? null
			: refused
				? `This version can't be published yet: ${findings[0]!.message}`
				: `Publish safety is off, but this version has a problem that would normally block it: ${findings[0]!.message}`;
	return { refused, findings, message };
}

/** True when a string is shaped like an app-key NAME (used by callers validating saved names). */
export function isAppKeyName(name: string): boolean {
	return APP_KEY_NAME.test(name);
}
