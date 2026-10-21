import { useMemo } from 'react';
import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { SignInScreen } from '../sign-in.tsx';
import { Mascot } from '@caddie/ui/Mascot';
import { Icon } from '../icons.tsx';
import { AccountBriefV2 } from '../brief/DecisionCard.tsx';
import { useDecisionCardAction } from '../brief/actions.ts';
import { useAccountBrief, useMarkBriefRead } from '../queries.ts';
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
	const openCards = (brief.data?.cards ?? []).filter((card) => card.status === 'needs-you' || card.status === 'blocked' || card.kind === 'change');
	const needsYou = openCards.length;
	const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
	// Honest background line: counts drawn only from real brief data — the
	// projects Caddie is tracking and the deadline cards it is watching. Never
	// an invented number; a zero count simply drops its clause.
	const watching = chrome.buildProjects.length;
	const deadlines = (brief.data?.cards ?? []).filter((card) => card.kind === 'deadline').length;
	const watchBits: string[] = [];
	if (watching > 0) watchBits.push(`${watching} project${watching === 1 ? '' : 's'}`);
	if (deadlines > 0) watchBits.push(`${deadlines} deadline${deadlines === 1 ? '' : 's'}`);
	const backgroundLine =
		watchBits.length > 0
			? `I've got the watch on ${watchBits.join(' and ')} — I'll surface anything the moment it matters.`
			: "I'll surface anything the moment it matters: a deadline, a rule change, a hackathon that fits you.";

	return (
		<div className="home-brief" data-testid="brief-screen">
			{needsYou > 0 ? (
				<header className="home-head" data-state="active">
					<span className="home-head-disc" aria-hidden="true">
						<Icon name="alert" title="Needs you" />
					</span>
					<div className="home-head-main">
						<h1 className="home-head-title">
							{`${needsYou} thing${needsYou === 1 ? '' : 's'} could use you`}
							<span className="home-head-count">{needsYou}</span>
						</h1>
						<p className="home-head-sub">
							<span className="home-head-date">{today}</span>
							<span className="home-head-dot" aria-hidden="true"> · </span>
							acting on a card is what decides it
						</p>
					</div>
				</header>
			) : (
				<header className="home-head home-head--calm" data-state="calm">
					<span className="home-head-mascot" aria-hidden="true">
						<Mascot mood="done" size={52} />
					</span>
					<div className="home-head-main">
						<h1 className="home-head-title">Nothing needs you — I&rsquo;ve got the watch.</h1>
						<p className="home-head-sub">
							<span className="home-head-date">{today}</span>
							<span className="home-head-dot" aria-hidden="true"> · </span>
							{backgroundLine}
						</p>
					</div>
				</header>
			)}

			<section className="card-surface home-panel" data-testid="brief-lane-panel">
				<AccountBriefV2
					state={{ kind: 'empty', stale: chrome.projectsFetching || brief.isFetching, retry: chrome.refreshAll }}
					cards={brief.data?.cards ?? []}
					projects={brief.data?.projects ?? []}
					asOf={brief.data?.asOf}
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

