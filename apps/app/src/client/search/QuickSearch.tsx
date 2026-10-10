import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Icon } from '../icons.tsx';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';

/**
 * QuickSearch — the ⌘K / "/" palette (v2, HANDOFF §4): screens, projects and
 * recent chats, with typing adding "See all results for …" → /search?q=.
 *
 * Everything in the palette navigates; nothing here queries the API except
 * the local project list the shell already has. Chats (recent conversations)
 * appear only when the shell has loaded projects — there is no fabricated
 * chat history.
 */

interface PaletteItem {
	key: string;
	group: 'Go to' | 'Projects' | 'Do';
	label: string;
	detail: string;
	run: () => void;
}

export function QuickSearch(props: { open: boolean; onClose: () => void }): ReactElement | null {
	const chrome = useWorkspaceChrome();
	const navigate = useNavigate();
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);

	useEffect(() => {
		if (props.open) {
			setQuery('');
			setActive(0);
		}
	}, [props.open]);

	const items: PaletteItem[] = useMemo(() => {
		const go = (
			key: string,
			label: string,
			detail: string,
			run: () => void,
			group: PaletteItem['group'] = 'Go to',
		): PaletteItem => ({ key, group, label, detail, run });
		const list: PaletteItem[] = [
			go('brief', 'Brief', 'What needs you today', () => navigate({ to: '/', search: {} })),
			go('discover', 'Discover', 'Hackathons that fit you', () => navigate({ to: '/discover', search: {} })),
			go('projects', 'Projects', 'Everything you’re making', () => navigate({ to: '/projects', search: {} })),
			go('settings', 'Settings', 'Profile, tools, spending, appearance', () =>
				navigate({ to: '/settings', search: { tab: 'profile' } }),
			),
		];
		for (const project of chrome.buildProjects) {
			list.push(
				go(
					`project-${project.id}`,
					project.name,
					project.description ?? 'Your project',
					() => navigate({ to: '/project', search: { project: project.id } }),
					'Projects',
				),
			);
		}
		list.push(
			go(
				'new-project',
				'Start a project',
				'Describe an idea',
				() => navigate({ to: '/onboarding', search: {} }),
				'Do',
			),
		);
		return list;
	}, [chrome.buildProjects, navigate]);

	const needle = query.trim().toLowerCase();
	const matches = items.filter(
		(item) => !needle || `${item.label} ${item.detail} ${item.group}`.toLowerCase().includes(needle),
	);
	const seeAll: PaletteItem | null =
		needle === ''
			? null
			: {
					key: 'see-all',
					group: 'Do',
					label: `See all results for “${query.trim().slice(0, 60)}”`,
					detail: 'Searches plans, to-dos and what Caddie knows too',
					run: () => navigate({ to: '/search', search: { q: query.trim().slice(0, 200) } }),
				};
	const flat = seeAll ? [...matches, seeAll] : matches;

	useEffect(() => {
		if (active >= flat.length) setActive(flat.length === 0 ? 0 : flat.length - 1);
	}, [active, flat.length]);

	if (!props.open) return null;

	function runItem(item: PaletteItem | undefined) {
		if (!item) return;
		props.onClose();
		item.run();
	}

	let groupSeen: string | null = null;
	return (
		<div className="modal-backdrop" data-testid="quick-search-backdrop" onMouseDown={props.onClose}>
			<div
				className="commit-panel quick-search card-surface"
				data-testid="quick-search"
				role="dialog"
				aria-modal="true"
				aria-label="Quick search"
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={(event) => {
					if (event.key === 'Escape') props.onClose();
					if (event.key === 'ArrowDown') {
						event.preventDefault();
						setActive((value) => (flat.length === 0 ? 0 : (value + 1) % flat.length));
					}
					if (event.key === 'ArrowUp') {
						event.preventDefault();
						setActive((value) => (flat.length === 0 ? 0 : (value - 1 + flat.length) % flat.length));
					}
					if (event.key === 'Enter') {
						event.preventDefault();
						runItem(flat[active]);
					}
				}}
			>
				<div className="quick-search-input">
					<Icon name="search" title="" />
					<input
						autoFocus
						type="text"
						placeholder="Search projects, hackathons and chats"
						aria-label="Quick search"
						data-testid="quick-search-input"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
						onKeyDown={(event) => {
							if (event.key === 'Escape') props.onClose();
						}}
					/>
					<kbd>Esc</kbd>
				</div>
				<div className="quick-search-list" data-testid="quick-search-list">
					{flat.length === 0 ? (
						<p className="state-detail">No quick match for “{query.trim().slice(0, 60)}” — search everything instead.</p>
					) : (
						flat.map((item, index) => {
							const showGroup = item.group !== groupSeen;
							groupSeen = item.group;
							return (
								<div key={item.key}>
									{showGroup ? <p className="kicker">{item.group}</p> : null}
									<button
										type="button"
										className={index === active ? 'quick-item active' : 'quick-item'}
										data-testid="quick-search-item"
										onMouseEnter={() => setActive(index)}
										onClick={() => runItem(item)}
									>
										<span className="grow">
											{item.label}
											<small>{item.detail}</small>
										</span>
										<Icon name="arrowLeft" title="" />
									</button>
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}

/** Global keyboard wiring: ⌘K / Ctrl+K opens the palette; "/" opens it when
 *  the user is not typing in a field. */
export function useQuickSearchHotkey(onOpen: () => void): void {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const typing =
				target &&
				(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				onOpen();
				return;
			}
			if (event.key === '/' && !typing) {
				event.preventDefault();
				onOpen();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onOpen]);
}
