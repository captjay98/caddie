import { useMemo } from 'react';
import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { SignInScreen } from '../sign-in.tsx';
import { Mascot } from '@caddie/ui/Mascot';
import { briefHeaderState } from './brief-header.ts';
import { AccountBriefV2 } from '../brief/DecisionCard.tsx';
import { useDecisionCardAction } from '../brief/actions.ts';
import { useAccountBrief, useMarkBriefRead, useSessionDisplayName } from '../queries.ts';
import { useWorkspaceChrome } from './Chrome.tsx';

/**
 * Brief — the default left-hand surface (approved navigation 2026-10-09).
 *
 * Brief leads with the ACCOUNT-wide update feed — every authorised project's
 * approvals, changes, deadlines, previews, submission gaps and saved
 * opportunities — grouped per project, ranked needs-you → changed → blocked →
 * handled. Read state is separate from resolution: opening Brief marks
 * nothing read; acting on a card marks it read AND navigates to the exact
 * work (audit F08 targeting, extended to previews/submissions/opportunities).
 *
 * A new account (no projects) sees the discovery-first intro with the three
 * start paths before an honest "what goes here" empty state; a returning
 * account with nothing outstanding gets "You're caught up". No match score is
 * ever invented: recommendations are exactly what the server evaluated, and
 * the live-source limitation stays explicit on opportunity cards.
 */

export function Shell(): ReactElement {
	// The chrome comes from the shell layout route once, above every page —
	// Brief renders only its content so navigating never remounts the
	// conversation (audit F01).
	return <BriefBody />;
}

function BriefBody(): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const brief = useAccountBrief(actor, false);
	const markRead = useMarkBriefRead(actor);
	const onCardAction = useDecisionCardAction();
	const displayName = useSessionDisplayName();

	if (!chrome.authenticated) return <SignInScreen />;

	// Every card routes by its OWN identity (briefActionRoute): kind picks the
	// surface, projectId scopes it, targetId is the exact revision/claim/
	// schedule/preview/package/candidate. Acting on a card marks it read —
	// reading never resolves the underlying work.

	function markAllRead() {
		const keys = (brief.data?.cards ?? [])
			.filter((card) => !card.seen)
			.map((card) => card.key)
			.filter((key): key is string => typeof key === 'string');
		if (keys.length > 0) void markRead.mutate(keys);
	}

	const isNewUser = chrome.buildProjects.length === 0;
	const cards = brief.data?.cards ?? [];
	const unseenCount = cards.filter(card => !card.seen).length;
	const header = briefHeaderState({ cards, pending: brief.isPending, error: Boolean(brief.error), transportMood: chrome.caddieMood });
	const now = new Date();
	const datePart = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, options).format(now);
	const name = displayName.data?.trim().split(/\s+/)[0];
	const nextCard = cards.find(card => card.status !== 'handled');
	const nextProject = brief.data?.projects.find(project => project.id === nextCard?.projectId);
	const context = nextCard?.kind === 'deadline' && !nextCard.schedule && nextProject
		? `${nextProject.name}’s deadline is coming up. Let’s leave time to tell its story.`
		: nextCard?.headline;

	return (
		<div className="home-brief" data-testid="brief-screen">
			<header className="home-head home-head--unified" data-state={header.state} data-testid="brief-head">
				<time className="home-head-calendar" dateTime={`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`} aria-label={datePart({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}>
					<span>{datePart({ weekday: 'long' })}</span>
					<strong>{datePart({ day: 'numeric' })}</strong>
					<span>{datePart({ month: 'long' })}</span>
				</time>
				<div className="home-head-main">
					<div className="home-head-leading">
						<span className="home-head-mascot" data-testid="brief-mascot" aria-hidden="true"><Mascot mood={header.mood} size={46} live /></span>
						<div><p className="home-head-greeting">Your brief{name ? `, ${name}` : ''}</p><h1 className="home-head-title">{header.title}</h1></div>
					</div>
					{context && !brief.error && !brief.isPending ? <p className="home-head-context">{context}</p> : null}
				</div>
			</header>

			<section className="home-panel" data-testid="brief-lane-panel">
				{brief.data && unseenCount > 0 ? <div className="brief-feed-toolbar" data-testid="brief-feed-toolbar">
					<span className="home-head-updates" data-testid="brief-count"><span className="home-head-new-dot" aria-hidden="true" />{unseenCount} new update{unseenCount === 1 ? '' : 's'}</span>
					<button type="button" className="brief-head-markread" data-testid="brief-mark-all-read" onClick={markAllRead} disabled={markRead.isPending}>{markRead.isPending ? 'Marking read…' : 'Mark all read'}</button>
				</div> : null}
				{markRead.error ? <p className="state-detail" role="alert">Couldn’t mark these updates read. Try again.</p> : null}
				<AccountBriefV2
					state={{ kind: 'empty', stale: chrome.projectsFetching || brief.isFetching, retry: chrome.refreshAll }}
					cards={brief.data?.cards ?? []}
					projects={brief.data?.projects ?? []}
					asOf={brief.data?.asOf}
					hideHeader
					feedPending={brief.isPending}
					feedError={brief.error}
					hasBuildProjects={!isNewUser}
					onAction={onCardAction}
					onMarkAllRead={markAllRead}
					onAskCaddie={() => chrome.goProjectTab('/', { pane: 'channel' })}
					onBrowse={() => chrome.goProjectTab('/discover', {})}
				/>
			</section>
		</div>
	);
}

