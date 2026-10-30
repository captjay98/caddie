/**
 * "Change approach when the same failure repeats" (owner 2026-10-29). A failed
 * run_checks is reduced to its first meaningful error line, with positions,
 * durations and temp paths removed, so the same failure is recognised on the
 * next run even when line numbers or timings move. Module state on purpose:
 * the host context is rebuilt per tool call, the coordinator isolate is not.
 */
export function checkFailureSignature(output: string): string {
	const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
	const line = lines.find((row) => /^(error|✗|\(fail\)|fail\b)/i.test(row)) ?? lines.find((row) => /error|expected|received|cannot|not found/i.test(row)) ?? lines[0] ?? 'no output';
	return line
		.replace(/\[\d+(\.\d+)?m?s\]/g, '')
		.replace(/:\d+(:\d+)?/g, '')
		.replace(/\/tmp\/[\w./-]+/g, '<tmp>')
		.replace(/\s+/g, ' ')
		.slice(0, 200)
		.trim();
}

const lastFailure = new Map<string, { signature: string; count: number }>();

/** Record a failure for `key`; returns how many times in a row it has now been seen. */
export function noteCheckFailure(key: string, signature: string): number {
	const last = lastFailure.get(key);
	const count = last && last.signature === signature ? last.count + 1 : 1;
	lastFailure.set(key, { signature, count });
	if (lastFailure.size > 500) lastFailure.delete(lastFailure.keys().next().value!);
	return count;
}
