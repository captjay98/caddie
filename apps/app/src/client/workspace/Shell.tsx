import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { SignInPanel } from '../auth.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { AccountBriefV2 } from '../brief/DecisionCard.tsx';
import { briefActionRoute } from '../brief/navigate.ts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAccountBrief, useDiscoveryCandidates, useMarkBriefRead, useProfile, type ProfileRecord } from '../queries.ts';
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
	const brief = useAccountBrief(actor);
	const markRead = useMarkBriefRead(actor);

	if (!chrome.authenticated) return <SignInWall />;

	// Every card routes by its OWN identity (briefActionRoute): kind picks the
	// surface, projectId scopes it, targetId is the exact revision/claim/
	// schedule/preview/package/candidate. Acting on a card marks it read —
	// reading never resolves the underlying work.
	function onCardAction(card: DecisionCardType) {
		if (card.key) void markRead.mutate([card.key]);
		const route = briefActionRoute(card, chrome.homeProject?.id ?? null);
		chrome.goProjectTab(route.to, route.search);
	}

	function markAllRead() {
		const keys = (brief.data?.cards ?? [])
			.filter((card) => !card.seen)
			.map((card) => card.key)
			.filter((key): key is string => typeof key === 'string');
		if (keys.length > 0) void markRead.mutate(keys);
	}

	const isNewUser = chrome.buildProjects.length === 0;
	const openCards = (brief.data?.cards ?? []).filter((card) => card.status !== 'handled');

	return (
		<div className="home-brief" data-testid="brief-screen">
			<header className="home-head">
				<p className="kicker" data-tone="action">
					BRIEF
				</p>
				<h1 className="page-title">
					{openCards.length > 0
						? `${openCards.length} thing${openCards.length === 1 ? '' : 's'} could use you today`
						: 'You\u2019re caught up'}
				</h1>
				<p className="page-lede">
					{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())} —
					what Caddie needs from you and what it finished. Reading an update never decides it; acting on
					it does.
				</p>
			</header>

			<ProfileSetup />

			{isNewUser ? (
				<section className="card-surface home-panel" data-testid="brief-primary">
					<h3 className="state-title">Ready when you are</h3>
					<p className="state-detail">
						Discovery works before you have any project — start by finding something that fits.
					</p>
					<div className="row">
						<button type="button" className="btn-key" data-testid="brief-find-hackathon" onClick={() => chrome.goProjectTab('/discover', {})}>
							Find a hackathon that fits you
						</button>
						<button type="button" className="btn-ghost" data-testid="brief-start-idea" onClick={chrome.newProject}>
							Start from an idea
						</button>
						<button type="button" className="btn-ghost" data-testid="brief-continue-code" onClick={() => chrome.goProjectTab('/repositories', {})}>
							Continue existing code
						</button>
					</div>
				</section>
			) : null}

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
				/>
			</section>
		</div>
	);
}

function SignInWall(): ReactElement {
	return (
		<div className="auth-hero">
			<p className="auth-hero-kicker">CADDIE · your build assistant</p>
			<h1 className="auth-hero-title">
				It reads the rules, drafts the plan, and builds it.
				<span className="auth-hero-sub">You approve every step.</span>
			</h1>
			<section className="sign-in-card card-surface">
				<p className="kicker" data-tone="action">
					CADDIE · WORKSPACE
				</p>
				<h2 className="sign-in-title">Sign in to your workspace</h2>
				<SignInPanel callbackURL="/app/" />
			</section>
		</div>
	);
}

// --- progressive profile setup ---------------------------------------------------

function profileComplete(profile: ProfileRecord | null): boolean {
	if (!profile) return false;
	return Boolean(profile.country && profile.timezone && profile.weeklyHours != null && profile.experienceLevel);
}

function ProfileSetup(): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const profile = useProfile(actor);
	const p = profile.data?.profile ?? null;
	const complete = profileComplete(p);

	if (!chrome.authenticated) return <></>;
	if (profile.isPending) return <StatePanel kind="loading" title="Checking your profile…" />;
	if (profile.error) {
		return (
			<StatePanel
				kind={failureKind(profile.error)}
				detail={profile.error instanceof Error ? profile.error.message : undefined}
				onRetry={failureKind(profile.error) === 'denied' ? undefined : () => void profile.refetch()}
			/>
		);
	}
	if (complete) {
		return (
			<section className="card-surface home-panel profile-complete" data-testid="profile-complete">
				<p className="state-detail">
					Profile is set — it shapes what Caddie recommends.{' '}
					<Link to="/settings" data-testid="profile-edit-link">
						Edit in Settings
					</Link>
				</p>
			</section>
		);
	}
	return <InlineProfile profile={p} actorId={chrome.actorId} onSaved={() => void profile.refetch()} />;
}

function InlineProfile(props: {
	profile: ProfileRecord | null;
	actorId: string | null;
	onSaved: () => void;
}): ReactElement {
	const navigate = useNavigate();
	const [country, setCountry] = useState(props.profile?.country ?? '');
	const [timezone, setTimezone] = useState(props.profile?.timezone ?? '');
	const [weeklyHours, setWeeklyHours] = useState(props.profile?.weeklyHours == null ? '' : String(props.profile.weeklyHours));
	const [experience, setExperience] = useState(props.profile?.experienceLevel ?? '');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	async function save() {
		setSaving(true);
		setError(null);
		setSaved(false);
		try {
			const res = await fetch('/api/profile', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					...(country.trim() ? { country: country.trim().toUpperCase() } : { country: null }),
					...(timezone.trim() ? { timezone: timezone.trim() } : { timezone: null }),
					...(weeklyHours.trim() === '' ? {} : { weeklyHours: Number(weeklyHours) }),
					...(experience === '' ? { experienceLevel: null } : { experienceLevel: experience }),
					stackIds: props.profile?.stackIds ?? [],
					freeTextInterests: props.profile?.freeTextInterests ?? [],
				}),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? 'Saving your profile failed.');
			}
			setSaved(true);
			props.onSaved();
			// The button says "Save & browse" — make it true: leave the form and
			// open Discover so the saved profile immediately shapes matches.
			void navigate({ to: '/discover' });
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Saving your profile failed.');
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="card-surface home-panel profile-setup" data-testid="profile-setup">
			<h3 className="state-title">A few fields sharpen your matches</h3>
			<p className="state-detail">
				Optional — Caddie works without them. Country, time zone, weekly hours and experience feed the
				eligibility verdicts.
			</p>
			<div className="row">
				<input className="input" placeholder="Country (2-letter, e.g. CL)" aria-label="Country" data-testid="home-profile-country" value={country} onChange={(e) => setCountry(e.target.value)} />
				<input className="input" placeholder="Time zone (e.g. Europe/Paris)" aria-label="Time zone" data-testid="home-profile-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
			</div>
			<div className="row">
				<input className="input" placeholder="Weekly hours (0–80)" aria-label="Weekly hours" type="number" min={0} max={80} data-testid="home-profile-hours" value={weeklyHours} onChange={(e) => setWeeklyHours(e.target.value)} />
				<select className="input" aria-label="Experience level" data-testid="home-profile-experience" value={experience} onChange={(e) => setExperience(e.target.value)}>
					<option value="">Not set</option>
					<option value="beginner">Beginner</option>
					<option value="intermediate">Intermediate</option>
					<option value="senior">Senior</option>
				</select>
			</div>
			<div className="row">
				<button type="button" className="btn-key" data-testid="home-profile-save" disabled={saving} onClick={() => void save()}>
					{saving ? 'Saving…' : 'Save & browse'}
				</button>
				{saved ? <span className="status-pill" data-status="handled" data-testid="home-profile-saved">saved</span> : null}
			</div>
			{error ? <p className="form-error" role="alert" data-testid="home-profile-error">{error}</p> : null}
		</section>
	);
}
