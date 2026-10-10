import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { fetchJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { useSessionActor } from '../queries.ts';
import { WORDS } from '../copy.ts';

/**
 * P14 scoped search UI. The search request goes to the real filtered
 * endpoint; the UI renders exactly the sections and hits the server returns —
 * it never merges, guesses or supplements results, so anything the user
 * cannot access simply does not exist in the response (isolation is
 * enforced server-side and proven by tests/search-isolation.test.ts).
 *
 * Audit F11/S39: every hit is a Link to its destination (project → overview,
 * plan document → plan review, task/memory → their surfaces), and the page
 * offset is real paging driven by the server's totals — not a fixed first
 * ten.
 */

interface SearchHit {
	type: 'project' | 'planDoc' | 'task' | 'memory';
	id: string;
	projectId: string | null;
	title: string;
	snippet: string | null;
}

interface SearchResults {
	query: string;
	sections: Record<
		'projects' | 'planDocs' | 'tasks' | 'memory',
		{ items: SearchHit[]; total: number }
	>;
	total: number;
	limit: number;
	offset: number;
}

const SECTION_LABELS: Record<string, string> = {
	projects: 'Projects',
	planDocs: 'Plan',
	tasks: 'To-do',
	memory: 'Caddie knows',
};

const PAGE_SIZE = 5; // v2 results: 5 per page with "1–5 of 7" + Previous/Next

/** Where a hit opens — every result is an exit into the product (audit S39). */
function hitDestination(hit: SearchHit): {
	to: string;
	search: Record<string, string | undefined>;
} {
	const project = hit.projectId ?? (hit.type === 'project' ? hit.id : undefined) ?? undefined;
	switch (hit.type) {
		case 'project':
			return { to: '/project', search: { project: hit.id } };
		case 'planDoc':
			return { to: '/design-review', search: { project: project ?? undefined } };
		case 'task':
			return { to: '/tasks', search: { project: project ?? undefined } };
		case 'memory':
			return { to: '/settings', search: { tab: 'knows' } };
	}
}

const RECENTS_KEY = 'caddie:recent-searches';

function loadRecents(): string[] {
	try {
		const raw = localStorage.getItem(RECENTS_KEY);
		const parsed: unknown = raw === null ? [] : JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 5) : [];
	} catch {
		return [];
	}
}

function saveRecent(query: string): void {
	const trimmed = query.trim();
	if (!trimmed) return;
	const next = [trimmed, ...loadRecents().filter((item) => item !== trimmed)].slice(0, 5);
	try {
		localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
	} catch {
		// private mode: recents stay session-only
	}
}

/** Highlight the matched words (§4): plain text segments + <mark> hits. */
function Highlight(props: { text: string; query: string }): ReactElement {
	const needle = props.query.trim();
	if (!needle) return <>{props.text}</>;
	const terms = needle.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
	if (terms.length === 0) return <>{props.text}</>;
	const lower = props.text.toLowerCase();
	const parts: ReactElement[] = [];
	let cursor = 0;
	let index = 0;
	while (cursor < props.text.length) {
		let next = -1;
		let len = 0;
		for (const term of terms) {
			const at = lower.indexOf(term, cursor);
			if (at !== -1 && (next === -1 || at < next)) {
				next = at;
				len = term.length;
			}
		}
		if (next === -1) break;
		if (next > cursor) parts.push(<span key={index++}>{props.text.slice(cursor, next)}</span>);
		parts.push(<mark key={index++}>{props.text.slice(next, next + len)}</mark>);
		cursor = next + len;
	}
	if (cursor < props.text.length) parts.push(<span key={index++}>{props.text.slice(cursor)}</span>);
	return <>{parts}</>;
}

export function Search(): ReactElement {
	const actor = useSessionActor(true);
	const navigate = useNavigate();
	const urlSearch = useSearch({ strict: false }) as { q?: string };
	const [input, setInput] = useState(urlSearch.q ?? '');
	// The query fires on submit (or Enter), not on every keystroke — and it
	// syncs to ?q= so the results page is a real URL (deep-linkable, back-button
	// friendly). An empty query shows recent searches.
	const [submitted, setSubmitted] = useState<string | null>(urlSearch.q ?? null);
	const [offset, setOffset] = useState(0);
	const [recents, setRecents] = useState<string[]>(loadRecents);
	// v2 filter chips with counts (§4): narrow the shown sections client-side.
	const [typeFilter, setTypeFilter] = useState<string | null>(null);

	const results = useQuery({
		queryKey: ['search', actor.data ?? 'pending', submitted ?? 'none', offset],
		queryFn: () =>
			fetchJson<SearchResults>(
				`/api/search?q=${encodeURIComponent(submitted ?? '')}&limit=${PAGE_SIZE}&offset=${offset}`,
			),
		enabled: actor.data != null && submitted !== null && submitted.trim() !== '',
	});

	function runSearch() {
		const trimmed = input.trim();
		if (trimmed === '') return;
		setOffset(0);
		setTypeFilter(null);
		setSubmitted(trimmed);
		saveRecent(trimmed);
		setRecents(loadRecents());
		void navigate({ to: '/search', search: { q: trimmed } });
	}

	const total = results.data?.total ?? 0;
	const shown = Math.min(offset + PAGE_SIZE, total);

	return (
		<section className="card-surface settings-panel" data-testid="search-panel" id="search-panel">
			<p className="kicker" data-tone="action">
				SEARCH
			</p>
			<h3 className="state-title">Search what you can access</h3>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					runSearch();
				}}
			>
				<span className="row">
					<input
						className="input"
						placeholder="Search projects, plans, tasks, memory…"
						aria-label="Search query"
						data-testid="search-input"
						value={input}
						onChange={(event) => setInput(event.target.value)}
					/>
					<button type="submit" className="btn-key" data-testid="search-submit" disabled={input.trim() === ''}>
						Search
					</button>
				</span>
			</form>

			{submitted === null ? (
				<div data-testid="search-idle">
					<p className="state-detail">
						Results only ever include content your account can access. Chats aren't searched yet.
					</p>
					{recents.length > 0 ? (
						<>
							<p className="kicker">Recent searches</p>
							<div className="row">
								{recents.map((recent) => (
									<button
										key={recent}
										type="button"
										className="detail-toggle"
										data-testid="search-recent"
										onClick={() => {
											setInput(recent);
											setOffset(0);
											setTypeFilter(null);
											setSubmitted(recent);
											void navigate({ to: '/search', search: { q: recent } });
										}}
									>
										{recent}
									</button>
								))}
							</div>
						</>
					) : null}
				</div>
			) : results.isPending ? (
				<StatePanel kind="loading" title={`Searching for “${submitted}”…`} />
			) : results.error ? (
				<StatePanel
					kind={failureKind(results.error)}
					detail={results.error instanceof Error ? results.error.message : undefined}
					onRetry={() => results.refetch()}
				/>
			) : total === 0 ? (
				<p className="state-detail" data-testid="search-empty">
					No matches for “{submitted}” in content you can access.
				</p>
			) : (
				<div data-testid="search-results">
					{/* v2 filter chips with counts (§4) — real counts from the server's
					    section totals; no hackathon chip until the server supports it. */}
					{(() => {
						const sections = results.data?.sections;
						if (!sections) return null;
						const chips = (Object.keys(SECTION_LABELS) as Array<'projects' | 'planDocs' | 'tasks' | 'memory'>)
							.filter((name) => (sections[name]?.total ?? 0) > 0)
							.map((name) => ({ name, total: sections[name]?.total ?? 0 }));
						if (chips.length === 0) return null;
						return (
							<div className="row" data-testid="search-filters">
								<button
									type="button"
									className="detail-toggle"
									data-testid="search-filter-all"
									aria-pressed={typeFilter === null}
									onClick={() => setTypeFilter(null)}
								>
									All
								</button>
								{chips.map((chip) => (
									<button
										key={chip.name}
										type="button"
										className="detail-toggle"
										data-testid={`search-filter-${chip.name}`}
										aria-pressed={typeFilter === chip.name}
										onClick={() => setTypeFilter(typeFilter === chip.name ? null : chip.name)}
									>
										{SECTION_LABELS[chip.name]} ({chip.total})
									</button>
								))}
							</div>
						);
					})()}
					{Object.entries(results.data?.sections ?? {}).map(([name, section]) =>
						section.items.length === 0 ? null : (
							<div key={name} data-testid={`search-section-${name}`}>
								<p className="kicker">
									{SECTION_LABELS[name] ?? name} ({section.total})
								</p>
								<div className="row-list">
									{section.items.map((hit) => {
										const dest = hitDestination(hit);
										return (
											<Link
												className="inspector-row"
												key={hit.id}
												data-testid="search-hit"
												to={dest.to}
												search={dest.search as never}
											>
												<div className="row-main">
													<span className="row-title">
														<Highlight text={hit.title} query={submitted ?? ''} />
													</span>
													<span className="row-status">{SECTION_LABELS[hit.type] ?? hit.type}</span>
												</div>
												{hit.snippet ? (
													<div className="row-details">
														<Highlight text={hit.snippet} query={submitted ?? ''} />
													</div>
												) : null}
											</Link>
										);
									})}
								</div>
							</div>
						),
					)}
					{total > PAGE_SIZE ? (
						<div className="row" data-testid="search-paging">
							<button
								type="button"
								className="btn-ghost"
								data-testid="search-prev"
								disabled={offset === 0}
								onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
							>
								← Newer
							</button>
							<span className="state-detail">
								{offset + 1}–{shown} of {total}
							</span>
							<button
								type="button"
								className="btn-ghost"
								data-testid="search-next"
								disabled={shown >= total}
								onClick={() => setOffset(offset + PAGE_SIZE)}
							>
								Older →
							</button>
						</div>
					) : null}
				</div>
			)}
		</section>
	);
}
