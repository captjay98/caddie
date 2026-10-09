import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { SignInPanel } from '../auth.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { BriefLane } from '../brief/DecisionCard.tsx';
import { Link } from '@tanstack/react-router';
import { useBriefCards, useDiscoveryCandidates, useProfile, type ProfileRecord } from '../queries.ts';
import { useWorkspaceChrome } from './Chrome.tsx';

/**
 * Home — the personalised, actionable brief (discovery-first redesign).
 *
 * Home is where the loop is steered from, so it leads with ONE thing the person
 * can do, backed only by real data:
 *   - A new account (no projects) sees a one-sentence explainer, a short
 *     progressive profile setup, a primary "Find a hackathon that fits you",
 *     a browse-anyway path, and secondary start paths — never an empty data pane.
 *   - A returning account sees what needs them (the brief), top
 *     recommendations, and project progress — one primary action per card.
 *
 * Honest states are distinct and never conflated: incomplete profile, loading,
 * no matches, failed, and stale are each their own message. There is no
 * account-wide brief-aggregation endpoint, so the needs-you lane reads the
 * actor's Home scope (the account project) — a known backend gap, surfaced as
 * such rather than faked with a merge across projects. No match score is ever
 * invented: recommendations are exactly what the server evaluated.
 */

export function Shell(): ReactElement {
	// The chrome comes from the shell layout route once, above every page —
	// Home renders only its content so navigating never remounts the
	// conversation (audit F01).
	return <HomeBody />;
}

function HomeBody(): ReactElement {
	const chrome = useWorkspaceChrome();
	if (!chrome.authenticated) return <SignInWall />;

	return (
		<div className="home-brief" data-testid="home-screen">
			<header className="home-head">
				<p className="kicker" data-tone="action">
					HOME
				</p>
				<h1 className="page-title">Caddie — your build assistant</h1>
				<p className="page-lede">
					You talk, Caddie reads the rules, drafts a plan and builds it. You approve every step. Here is what
					it needs from you and what it found.
				</p>
			</header>

			<ProfileSetup />

			<section className="card-surface home-panel" data-testid="home-primary">
				<h3 className="state-title">Ready when you are</h3>
				<p className="state-detail">
					Discovery works before you have any project — start by finding something that fits.
				</p>
				<div className="row">
					<button type="button" className="btn-key" data-testid="home-find-hackathon" onClick={() => chrome.goProjectTab('/discover', {})}>
						Find a hackathon that fits you
					</button>
					<button type="button" className="btn-ghost" data-testid="home-start-idea" onClick={chrome.newProject}>
						Start from an idea instead
					</button>
				</div>
			</section>

			<Recommendations />
			<NeedsYou />
			<ProjectProgress />
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
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Saving your profile failed.');
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="card-surface home-panel profile-setup" data-testid="profile-setup">
			<h3 className="state-title">Two fields sharpen your matches</h3>
			<p className="state-detail">Optional — Caddie works without them. These feed the eligibility verdicts.</p>
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

// --- recommendations (what the server actually ranked) ---------------------------

function Recommendations(): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const candidates = useDiscoveryCandidates(actor, chrome.homeProject?.id ?? null);

	if (chrome.projectsError) {
		return (
			<StatePanel
				kind={failureKind(chrome.projectsError)}
				detail={chrome.projectsError instanceof Error ? chrome.projectsError.message : undefined}
			/>
		);
	}
	const ranked = candidates.data?.ranked ?? [];
	return (
		<section className="card-surface home-panel" data-testid="home-recommendations">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						DISCOVER
					</p>
					<h3 className="state-title">Top matches</h3>
					<p className="state-detail">
						{candidates.data
							? `Ranked only on what Caddie could actually read${candidates.data.profileCountry ? ` · eligibility uses ${candidates.data.profileCountry}` : ' · no country recorded, eligibility stays UNKNOWN'}.`
							: 'Reading the feeds this account watches…'}
					</p>
				</div>
			</div>
			{candidates.isFetching && candidates.data ? (
				<p className="stale-note mono-id" data-testid="home-recommendations-stale">
					updating…
				</p>
			) : null}
			{candidates.isPending ? (
				<StatePanel kind="loading" title="Reading recommendations…" />
			) : candidates.error ? (
				<StatePanel kind={failureKind(candidates.error)} detail={candidates.error instanceof Error ? candidates.error.message : undefined} onRetry={failureKind(candidates.error) === 'denied' ? undefined : () => void candidates.refetch()} />
			) : ranked.length === 0 ? (
				<StatePanel kind="empty" title="No matches read yet" detail="Nothing has been swept for this account — run the feed in Discover and this fills with real, evidenced matches." />
			) : (
				<ul className="rec-list">
					{ranked.slice(0, 3).map((entry) => (
						<li key={entry.candidateId} className="rec-item">
							<span className="rec-title">{entry.candidateId}</span>
							<span className="rec-fit mono-id">{entry.matchedRequirements} requirement(s) evidenced · {entry.verdict}</span>
						</li>
					))}
				</ul>
			)}
			<div className="row">
				<button type="button" className="btn-ghost" data-testid="home-open-discover" onClick={() => chrome.goProjectTab('/discover', {})}>
					Open Discover
				</button>
			</div>
		</section>
	);
}

// --- needs-you (the account-scope brief) -----------------------------------------

function NeedsYou(): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const brief = useBriefCards(actor, chrome.homeProject?.id ?? null);

	function onCardAction(card: DecisionCardType) {
		void card;
		chrome.goProjectTab('/project', {});
	}

	return (
		<section className="card-surface home-panel" data-testid="home-needs-you">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						NEEDS YOU
					</p>
					<h3 className="state-title">Waiting on your OK</h3>
					<p className="state-detail">
						Decisions from your account scope. An account-wide brief roll-up across every project is not
						yet exposed by the server — this shows the account (Home) scope only.
					</p>
				</div>
			</div>
			<BriefLane
				state={{ kind: 'empty', stale: chrome.projectsFetching, retry: chrome.refreshAll }}
				cards={brief.data?.cards ?? []}
				feedPending={brief.isPending}
				feedError={brief.error}
				onAction={onCardAction}
			/>
		</section>
	);
}

// --- project progress ------------------------------------------------------------

function ProjectProgress(): ReactElement {
	const chrome = useWorkspaceChrome();
	if (chrome.buildProjects.length === 0) {
		return (
			<section className="card-surface home-panel" data-testid="home-progress-empty">
				<p className="state-detail">No projects yet — find a hackathon or start from an idea to begin.</p>
			</section>
		);
	}
	return (
		<section className="card-surface home-panel" data-testid="home-progress">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						BUILD
					</p>
					<h3 className="state-title">Where your projects stand</h3>
				</div>
			</div>
			<ul className="project-list">
				{chrome.buildProjects.slice(0, 4).map((project) => (
					<li key={project.id} className="project-row" data-testid={`home-project-${project.id}`}>
						<button type="button" className="row-title r-link" onClick={() => chrome.openProject(project.id)}>
							{project.name}
						</button>
						<span className="project-row-meta mono-id" data-status={project.status}>
							{project.status}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}
