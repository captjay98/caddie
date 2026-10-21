import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStatus, useCreateProject, useSessionActor, useHomeProject } from '../queries.ts';
import { Mascot } from '@caddie/ui/Mascot';
import { Icon, type IconName } from '../icons.tsx';

/** Storage key for the name the user gave Caddie in the welcome (v2 §4). */
export const PROFILE_NAME_KEY = 'caddie:profile-name';

/**
 * The suggested first name (§4 Welcome): take the first word of the account
 * name — but a single token containing digits or symbols is a username, not a
 * name, so it suggests nothing (the input stays empty).
 */
export function suggestFirstName(full: string | null | undefined): string {
	const cleaned = String(full ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
	if (!cleaned) return '';
	if (!cleaned.includes(' ') && /[\d_.\-]/.test(cleaned)) return '';
	return cleaned.split(' ')[0] ?? '';
}

export function saveProfileName(name: string): void {
	try {
		const trimmed = name.trim().slice(0, 40);
		if (trimmed) localStorage.setItem(PROFILE_NAME_KEY, trimmed);
		else localStorage.removeItem(PROFILE_NAME_KEY);
	} catch {
		// private mode: the name stays session-only
	}
}

/**
 * Onboarding entry — three ways to start, in the order the product promises
 * (audit S17/F05): discovery first, an idea second, your own code third.
 *
 * The idea path is a REAL capture now (audit S17): a project name plus the
 * idea in plain words, persisted as the project's description, landing in the
 * new project. Visible errors; no silent swallowing. The discovery and
 * repository cards are typed router links (F05) — internal navigation never
 * reloads the document, and `/app` deep links keep working.
 *
 * Rendered inside the shell layout's chrome on the zero-project Home branch
 * and standalone on /onboarding (before the workspace exists); never opens
 * its own `<main>`. It resolves the session and home project through queries,
 * not the workspace chrome, so it works in both places.
 */

export type StartingPoint = 'hackathon' | 'idea' | 'explore';

const STARTING_POINTS: { id: StartingPoint; title: string; detail: string; action: string; icon: IconName }[] = [
 { id: 'hackathon', title: 'Find a hackathon', detail: 'Discover something worth building for.', action: 'Find my fit', icon: 'trophy' },
 { id: 'idea', title: 'I have an idea', detail: 'Turn it into a plan and a working app.', action: 'Start with my idea', icon: 'sparkle' },
 { id: 'explore', title: 'I’m exploring', detail: 'Help me figure out where to begin.', action: 'Help me get started', icon: 'target' },
];

/** A purposeful welcome; the chosen path is handed to the completion flow. */
export function WelcomeIntro(props: { onDone: (startingPoint: StartingPoint) => void }): ReactElement {
 const sessionName = useSessionName();
 const [startingPoint, setStartingPoint] = useState<StartingPoint>('hackathon');
 const selected = STARTING_POINTS.find(item => item.id === startingPoint)!;
	const [stage, setStage] = useState<'intro' | 'name'>('intro');
	const suggested = suggestFirstName(sessionName);
	const [name, setName] = useState('');
	const [usernameHint, setUsernameHint] = useState(false);

	useEffect(() => {
		if (stage === 'name') {
			setName(suggested);
			setUsernameHint(suggested === '' && Boolean(sessionName));
		}
	}, [stage, suggested, sessionName]);

	if (stage === 'intro') {
  return (
   <section className="card-surface start-card welcome-intro welcome-starting-point" data-testid="welcome-intro">
    <p className="welcome-start-label">LET’S GET STARTED</p>
    <header className="welcome-start-head">
     <span className="welcome-start-mascot" aria-hidden="true"><Mascot mood="ready" size={80} live /></span>
     <h1 className="welcome-intro-hello">Hi, I’m Caddie.<br />What brings you here?</h1>
    </header>
    <p className="welcome-start-lede">Pick a starting point. You can change your mind anytime.</p>
    <fieldset className="welcome-start-choices">
     <legend className="sr-only">Your starting point</legend>
     {STARTING_POINTS.map(item => (
      <label className="welcome-start-choice" key={item.id} data-selected={startingPoint === item.id}>
       <input type="radio" name="starting-point" value={item.id} checked={startingPoint === item.id} onChange={() => setStartingPoint(item.id)} />
       <span className="welcome-start-icon" aria-hidden="true"><Icon name={item.icon} title="" /></span>
       <span><strong>{item.title}</strong><small>{item.detail}</small></span>
      </label>
     ))}
    </fieldset>
    <details className="welcome-definition">
     <summary>What’s a hackathon?</summary>
     <p>An event where you build a project, on your own or with a team, and present it within a set time. Many run online.</p>
    </details>
    <div className="row-actions">
     <button type="button" className="btn-key welcome-primary" data-testid="welcome-next" onClick={() => setStage('name')}>{selected.action}<span aria-hidden="true"> →</span></button>
    </div>
   </section>
  );
 }

	if (stage === 'name') {
		return (
			<section className="card-surface start-card welcome-intro welcome-starting-point welcome-name-step" data-testid="welcome-name">
                <div className="welcome-name-top">
                    <button type="button" className="btn-ghost" aria-label="Back" onClick={() => setStage('intro')}>← Back</button>
                    <p className="welcome-start-label">A LITTLE ABOUT YOU</p>
                </div>
                <header className="welcome-start-head">
                    <span className="welcome-start-mascot" aria-hidden="true"><Mascot mood="listening" size={80} live /></span>
                    <h1 className="welcome-intro-hello">What should I call you?</h1>
                </header>
                <p className="welcome-start-lede">A first name or nickname is perfect. You can change it anytime.</p>
                <form className="welcome-name-form" onSubmit={(event) => {
                    event.preventDefault();
                    saveProfileName(name);
                    props.onDone(startingPoint);
                }}>
				<div className="welcome-name-ask">
                    <label htmlFor="welcome-profile-name">Your name</label>
					<input
						id="welcome-profile-name"
						className="input"
						data-testid="welcome-name-input"
						aria-label="What should I call you?"
						placeholder="Your first name"
                        autoComplete="given-name"
                        aria-describedby="welcome-name-hint"
						value={name}
						maxLength={40}
						onChange={(event) => setName(event.target.value)}
					/>
					{sessionName ? (
						<p className="welcome-name-note" id="welcome-name-hint">From your account. Change it if you like.</p>
					) : (
						<p className="welcome-name-note" id="welcome-name-hint">Caddie greets you by this name.</p>
					)}
					{usernameHint ? (
						<p className="welcome-name-note">
							Your account name looks like a username, so I left this blank.
						</p>
					) : null}
				</div>
				<div className="row-actions">
					<button
						type="submit"
						className="btn-key welcome-primary"
						data-testid="welcome-name-save"
					>
						Continue <span aria-hidden="true">→</span>
					</button>
					<button
						type="button"
						className="btn-ghost"
						data-testid="welcome-name-skip"
						onClick={() => {
							saveProfileName('');
							props.onDone(startingPoint);
						}}
					>
						Skip — I&rsquo;ll add it later
					</button>
				</div>
                </form>
			</section>
		);
	}

	return <></>;
}

/** The verified session's account name (for the welcome prefill suggestion). */
function useSessionName(): string | null {
	const auth = useAuthStatus();
	const actor = useSessionActor(Boolean(auth.data?.authenticated));
	const [name, setName] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		if (!actor.data) return;
		void fetch('/api/auth/get-session', { credentials: 'same-origin' })
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { user?: { name?: unknown } } | null) => {
				if (cancelled) return;
				const value = body?.user?.name;
				setName(typeof value === 'string' && value.trim() !== '' ? value : null);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [actor.data]);
	return name;
}

function StartCard(props: {
	testId: string;
	kicker: string;
	title: string;
	detail: string;
	action?: ReactElement;
	planned?: boolean;
}): ReactElement {
	return (
		<section className="card-surface start-card" data-testid={props.testId}>
			<p className="kicker" data-tone={props.planned ? 'planned' : 'action'}>
				{props.kicker}
			</p>
			<h3 className="start-card-title">{props.title}</h3>
			<p className="start-card-detail">{props.detail}</p>
			{props.planned ? (
				<p className="status-pill" data-status="planned">
					Coming soon — needs a GitHub connection first
				</p>
			) : null}
			{props.action ? <div className="start-card-actions">{props.action}</div> : null}
		</section>
	);
}

/**
 * The idea capture (audit S17): name + plain-words idea → one project with
 * the idea persisted as its description → straight into that project. Errors
 * are visible; the busy lock prevents duplicate projects.
 */
export function IdeaForm(): ReactElement {
	const auth = useAuthStatus();
	const session = useSessionActor(Boolean(auth.data?.authenticated));
	const actor = useMemo(() => ({ actorId: session.data ?? null }), [session.data]);
	const home = useHomeProject(actor, Boolean(auth.data?.authenticated));
	const createProject = useCreateProject(actor);
	const navigate = useNavigate();
	const [name, setName] = useState('');
	const [idea, setIdea] = useState('');
	const [error, setError] = useState<string | null>(null);
	const busy = createProject.isPending;

	async function submit() {
		if (!name.trim() || busy) return;
		setError(null);
		try {
			const result = await createProject.mutateAsync({
				name: name.trim(),
				...(idea.trim() ? { description: idea.trim() } : {}),
				workspaceId: home.data?.project.workspaceId,
			});
			void navigate({ to: '/project', search: { project: result.project.id } });
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Creating the project failed.');
		}
	}

	return (
		<form
			data-testid="idea-form"
			className="idea-form"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<input
				className="input"
				placeholder="Project name (e.g. Pomodoro timer)"
				aria-label="Project name"
				data-testid="idea-name"
				value={name}
				onChange={(event) => setName(event.target.value)}
			/>
			<textarea
				className="input"
				placeholder="Describe the idea in your own words — what it does, who it's for. Caddie reads this before writing the plan."
				aria-label="Your idea"
				data-testid="idea-text"
				rows={3}
				value={idea}
				onChange={(event) => setIdea(event.target.value)}
			/>
			<button type="submit" className="btn-key" data-testid="idea-create" disabled={!name.trim() || busy}>
				{busy ? 'Creating…' : 'Create the project'}
			</button>
			{error ? (
				<p className="form-error" role="alert" data-testid="idea-error">
					{error}
				</p>
			) : null}
		</form>
	);
}

export function Start(props: { onStartIdea?: () => void; ideaForm?: ReactElement } = {}): ReactElement {
	return (
		<div className="start-screen" data-testid="start-screen">
			<header className="start-head">
				<p className="kicker" data-tone="action">
					GET STARTED
				</p>
				<h1 className="start-title">What do you want to build?</h1>
				<p className="start-lede">
					Pick a starting point — you can change direction any time. Caddie shows you a plan and
					waits for your OK before anything happens.
				</p>
				<ol className="loop-strip" aria-label="How Caddie works">
					<li><span className="loop-step">Find</span> a contest</li>
					<li><span className="loop-step">Plan</span> — you say it's good</li>
					<li><span className="loop-step">Build</span> — Caddie writes it</li>
					<li><span className="loop-step">Check</span> — proof kept</li>
					<li><span className="loop-step">Submit</span> — you post it</li>
				</ol>
			</header>
			<div className="start-cards">
				<StartCard
					testId="start-card-idea"
					kicker="START WITH AN IDEA"
					title="Describe what you want to build"
					detail="Tell Caddie your idea in plain words. It writes a step-by-step plan, shows you where every fact came from, and waits for your approval before building anything."
					action={
						props.ideaForm ?? (
							props.onStartIdea ? (
								<button
									type="button"
									className="btn-key"
									data-testid="start-idea-go"
									onClick={props.onStartIdea}
								>
									Start with an idea
								</button>
							) : (
								<Link className="btn-key" to="/" data-testid="start-idea-go">
									Open the workspace
								</Link>
							)
						)
					}
				/>
				<StartCard
					testId="start-card-discovery"
					kicker="OR START FROM A HACKATHON"
					title="Pick a contest Caddie found for you"
					detail="Browse real hackathons with the deadlines, the rules, and why each one fits you — every claim links to its source, and saving one keeps it on your shortlist."
					action={
						<Link className="btn-key" to="/discover" data-testid="start-discovery-go">
							Browse hackathons
						</Link>
					}
				/>
				<StartCard
					testId="start-card-repo"
					kicker="START FROM YOUR OWN CODE"
					title="Build on top of a GitHub repository"
					detail="Connect your GitHub and Caddie can work on code you already have. This one isn't connected yet — the moment it is, this card becomes a real starting point."
					planned
					action={
						<Link className="r-link" to="/repositories" data-testid="start-repo-go">
							See what the connection will ask for
						</Link>
					}
				/>
			</div>
			<p className="start-footnote">
				Your profile (country, hours, interests) is optional and lives in Settings — Caddie works
				without it.
			</p>
		</div>
	);
}
