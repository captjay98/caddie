/** B07.2 — truthful failure text (PURE, dependency-free leaf).
 *
 * A build that cannot finish must tell a nontechnical user three things and
 * nothing worse: what is SAVED, what is incomplete, and what to do NEXT. It
 * must never ask them to read a log, inspect the harness, or debug — that is
 * Caddie's job, not theirs. This validator is a regression lock over the
 * hand-written blocker/failure strings so a future edit cannot silently slip
 * in a "check the stack trace" message.
 */

/** Jargon that means a nontechnical user is being asked to debug, or that a
 * secret/internal detail is leaking into user-facing copy. Case-insensitive. */
export const FORBIDDEN_DEBUG_TOKENS = [
	'stack trace',
	'traceback',
	'exit code',
	'null pointer',
	'undefined is not',
	'segfault',
	'stderr',
	'stdout',
	'exception',
	'harness',
	'api key',
	'token',
	'env var',
	'environment variable',
] as const;

export type FailureMessageCheck = { ok: true } | { ok: false; reason: string };

/** A user-facing build-failure message is acceptable when it (a) says what is
 * saved, (b) offers a next step, and (c) carries no debug/jargon/secret token. */
export function buildFailureMessageOk(message: string): FailureMessageCheck {
	const text = message.toLowerCase();
	const leaked = FORBIDDEN_DEBUG_TOKENS.find((token) => text.includes(token));
	if (leaked) return { ok: false, reason: `contains debug/jargon term "${leaked}"` };
	if (!/saved/.test(text)) return { ok: false, reason: 'does not tell the user what is saved' };
	if (!/(retry|try again|not ready|waiting|connect|messages you|continue)/.test(text))
		return { ok: false, reason: 'does not tell the user what happens next' };
	return { ok: true };
}
