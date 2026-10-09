import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { fetchJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { useSessionActor } from '../queries.ts';

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
	planDocs: 'Plan documents',
	tasks: 'Tasks',
	memory: 'Memory',
};

const PAGE_SIZE = 10;

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
			return { to: '/settings', search: { section: 'memory' } };
	}
}

export function Search(): ReactElement {
	const actor = useSessionActor(true);
	const [input, setInput] = useState('');
	// The query fires on submit (or Enter), not on every keystroke.
	const [submitted, setSubmitted] = useState<string | null>(null);
	const [offset, setOffset] = useState(0);

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
		setSubmitted(trimmed);
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
				<p className="state-detail" data-testid="search-idle">
					Results only ever include content your account can access.
				</p>
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
													<span className="row-title">{hit.title}</span>
													<span className="row-status">{SECTION_LABELS[hit.type] ?? hit.type}</span>
												</div>
												{hit.snippet ? <div className="row-details">{hit.snippet}</div> : null}
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
