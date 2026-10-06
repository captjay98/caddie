import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { useSessionActor } from '../queries.ts';

/**
 * P14 scoped search UI. The search request goes to the real filtered
 * endpoint; the UI renders exactly the sections and hits the server returns —
 * it never merges, guesses or supplements results, so anything the user
 * cannot access simply does not exist in the response (isolation is
 * enforced server-side and proven by tests/search-isolation.test.ts).
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

export function Search(): ReactElement {
	const actor = useSessionActor(true);
	const [input, setInput] = useState('');
	// The query fires on submit (or Enter), not on every keystroke.
	const [submitted, setSubmitted] = useState<string | null>(null);

	const results = useQuery({
		queryKey: ['search', actor.data ?? 'pending', submitted ?? 'none'],
		queryFn: () =>
			fetchJson<SearchResults>(
				`/api/search?q=${encodeURIComponent(submitted ?? '')}&limit=10&offset=0`,
			),
		enabled: actor.data != null && submitted !== null && submitted.trim() !== '',
	});

	function runSearch() {
		const trimmed = input.trim();
		if (trimmed === '') return;
		setSubmitted(trimmed);
	}

	return (
		<section className="card-surface" data-testid="search-panel">
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
			) : (results.data?.total ?? 0) === 0 ? (
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
									{section.items.map((hit) => (
										<div className="inspector-row" key={hit.id} data-testid="search-hit">
											<div className="row-main">
												<span className="row-title">{hit.title}</span>
												<span className="row-status">{hit.type}</span>
											</div>
											{hit.snippet ? <div className="row-details">{hit.snippet}</div> : null}
										</div>
									))}
								</div>
							</div>
						),
					)}
				</div>
			)}
		</section>
	);
}
