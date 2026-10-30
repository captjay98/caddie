import type { BuildFeatureView } from '@caddie/contracts';
import type { BuildActivityView, BuildRoundView } from '../queries.ts';

/**
 * The build activity dialog's Checks and Attempts views, derived from the
 * same recorded rows (owner 2026-10-30): the old Attempts list was 60 flat
 * lines like "Looked into a problem — … odd-day-tip:behavior-tests ·
 * 10/30/2026, 1:15:05 PM", and the Checks tab drew the build as a straight
 * line (workspace → write → tests → final checks → preview) while it really
 * loops per part. Pure: no clock except the `now` passed in, nothing guessed.
 */

export type RoundKind = 'own-tests' | 'browser-checks' | 'new-tests' | 'other';
export type RoundOutcome = 'passed' | 'failed' | 'other';

export interface AttemptEntry {
	readonly kind: RoundKind;
	readonly title: string;
	readonly outcome: RoundOutcome;
	/** One short line: "86 of 87 passed", "2 failed". */
	readonly summary: string;
	/** The failing browser checks, in the approved wording. */
	readonly failing: readonly string[];
	/** The full recorded text, for whoever wants to dig in. */
	readonly detail: string | null;
	/** True when the detail is a raw recorded payload (JSON). */
	readonly raw: boolean;
	readonly at: string;
	/** Identical runs in a row are shown once: "×3". */
	readonly repeats: number;
}

export interface PartAttempts {
	readonly featureId: string;
	readonly title: string;
	readonly status: BuildFeatureView['status'] | 'unknown';
	readonly position: number | null;
	/** Newest first, identical neighbours folded together. */
	readonly entries: readonly AttemptEntry[];
	readonly ownRuns: number;
	readonly browserRuns: number;
	readonly latestOwn: { readonly passed: number; readonly total: number; readonly at: string } | null;
	readonly latestBrowser: { readonly failed: number; readonly failing: readonly string[]; readonly at: string } | null;
	readonly firstAt: string;
	readonly lastAt: string;
}

const CHECK_NAMES: Record<string, string> = {
	dependencies: 'Install packages',
	'browser-bundle': 'Build for the browser',
	'app-setup': 'Set up the Android app',
	'android-app': 'Build the Android app',
};

function split(issue: string): { featureId: string; check: string } {
	const at = issue.lastIndexOf(':');
	return at < 0 ? { featureId: '', check: issue } : { featureId: issue.slice(0, at), check: issue.slice(at + 1) };
}

function outcomeOf(outcome: string): RoundOutcome {
	if (outcome === 'failed') return 'failed';
	if (outcome === 'passed' || outcome === 'succeeded') return 'passed';
	return 'other';
}

/** "1. “Saving 205 …” — the host did: …" lines → the approved check wording. */
export function failingChecks(detail: string | null): string[] {
	if (!detail) return [];
	// The activity read may fold the newlines, so a number need not start a line.
	return [...detail.matchAll(/(?:^|\s)\d+\. “([^”]{1,400})”/g)].map((match) => match[1]!.trim());
}

function firstSentence(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
	const end = line.search(/[.!?](\s|$)/);
	const sentence = end > 0 ? line.slice(0, end + 1) : line;
	return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

/** One recorded round, in plain words. */
export function attemptEntry(round: BuildRoundView): AttemptEntry {
	const { check } = split(round.issue);
	const outcome = outcomeOf(round.outcome);
	const detail = round.detail?.trim() ? round.detail.trim() : null;
	const raw = detail !== null && /^[{[]/.test(detail);
	const base = { outcome, detail, raw, at: round.at, repeats: 1 };
	if (check === 'behavior-tests') {
		const counts = detail ? /(\d+) of (\d+) passed/.exec(detail) : null;
		return {
			...base,
			kind: 'own-tests',
			// The builder's own runs are free (round 'diagnosis'); a hand-in
			// that failed its tests spent one of the part's fix tries.
			title: round.round === 'diagnosis' ? 'Ran its own tests' : 'Fix handed in: its own tests',
			summary: counts ? `${counts[1]} of ${counts[2]} passed` : outcome === 'passed' ? 'Passed' : raw || !detail ? 'Failed' : firstSentence(detail),
			failing: [],
		};
	}
	if (check === 'independent-criteria') {
		const failing = failingChecks(detail);
		const count = detail ? Number(/failed \((\d+)\)/.exec(detail)?.[1] ?? failing.length) : failing.length;
		return {
			...base,
			kind: 'browser-checks',
			title: 'Caddie’s browser checks',
			summary: outcome === 'passed' ? 'All passed' : count > 0 ? `${count} failed` : 'Failed',
			failing,
		};
	}
	if (check === 'new-tests') {
		return { ...base, kind: 'new-tests', title: 'New tests for this part', summary: detail && !raw ? firstSentence(detail) : outcome === 'passed' ? 'Passed' : 'Failed', failing: [] };
	}
	const name = CHECK_NAMES[check];
	return {
		...base,
		kind: 'other',
		title: name ?? (round.round === 'transport_retry' ? 'Retried after a connection hiccup' : round.round === 'framework_recovery' ? 'Recovered and carried on' : 'Check'),
		summary: detail && !raw ? firstSentence(detail) : outcome === 'passed' ? 'Passed' : outcome === 'failed' ? 'Failed' : '',
		failing: [],
	};
}

/** Identical neighbours ("58 of 59 passed" three times running) fold into one. */
function fold(entries: readonly AttemptEntry[]): AttemptEntry[] {
	const out: AttemptEntry[] = [];
	for (const entry of entries) {
		const prev = out.at(-1);
		if (prev && prev.title === entry.title && prev.summary === entry.summary && prev.outcome === entry.outcome && prev.failing.join('\n') === entry.failing.join('\n') && !entry.raw) {
			out[out.length - 1] = { ...prev, repeats: prev.repeats + 1 };
			continue;
		}
		out.push(entry);
	}
	return out;
}

/** Every part that has recorded rounds, the most recently worked on first. */
export function partAttempts(data: Pick<BuildActivityView, 'rounds' | 'features'>): PartAttempts[] {
	const features = new Map((data.features ?? []).map((feature) => [feature.id, feature]));
	const groups = new Map<string, BuildRoundView[]>();
	for (const round of data.rounds) {
		const { featureId } = split(round.issue);
		const list = groups.get(featureId) ?? [];
		list.push(round);
		groups.set(featureId, list);
	}
	const parts: PartAttempts[] = [];
	for (const [featureId, rounds] of groups) {
		const ordered = [...rounds].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
		const entries = ordered.map(attemptEntry);
		const own = entries.find((entry) => entry.kind === 'own-tests' && /^\d+ of \d+ passed$/.test(entry.summary));
		const ownCounts = own ? /^(\d+) of (\d+)/.exec(own.summary) : null;
		const browser = entries.find((entry) => entry.kind === 'browser-checks');
		const feature = features.get(featureId);
		parts.push({
			featureId,
			title: feature ? feature.title.replace(/^\s*\d+[.)]\s*/, '') : featureId ? featureId.replace(/-/g, ' ') : 'The whole app',
			status: feature?.status ?? 'unknown',
			position: feature?.position ?? null,
			entries: fold(entries),
			ownRuns: entries.filter((entry) => entry.kind === 'own-tests').length,
			browserRuns: entries.filter((entry) => entry.kind === 'browser-checks').length,
			latestOwn: own && ownCounts ? { passed: Number(ownCounts[1]), total: Number(ownCounts[2]), at: own.at } : null,
			latestBrowser: browser ? { failed: browser.outcome === 'passed' ? 0 : Number(/^(\d+)/.exec(browser.summary)?.[1] ?? browser.failing.length), failing: browser.failing, at: browser.at } : null,
			firstAt: ordered.at(-1)!.at,
			lastAt: ordered[0]!.at,
		});
	}
	return parts.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/**
 * How many browser checks the host runs when it checks this part: every
 * finished part's checks again, plus this part's own (coordinator-host runs
 * the passed rows and the current one).
 */
export function browserChecksInRun(features: readonly BuildFeatureView[], featureId: string): number | null {
	const current = features.find((feature) => feature.id === featureId);
	if (!current) return null;
	return features
		.filter((feature) => feature.id === featureId || (feature.status === 'passed' && feature.position < current.position))
		.reduce((sum, feature) => sum + feature.doneWhen.length, 0);
}

/** "13:24" today, "29 Oct, 13:24" another day — in the reader's own time zone. */
export function clockTime(iso: string, now: Date = new Date()): string {
	const at = new Date(iso);
	if (!Number.isFinite(at.getTime())) return '';
	const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}
