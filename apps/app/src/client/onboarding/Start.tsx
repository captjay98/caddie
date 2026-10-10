import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStatus, useCreateProject, useSessionActor } from '../queries.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { Mascot, type MascotMood } from '@caddie/ui/Mascot';

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
 * and on /onboarding; never opens its own `<main>`.
 */

/**
 * The welcome intro (v2, HANDOFF §4 Welcome): Caddie introduces itself one
 * line at a time with its face changing per line, asks what to call you
 * (prefilled from the account, never a username), then shows the three moods,
 * then hands off to the start paths. "Say that again" replays;
 * prefers-reduced-motion shows all lines at once. The saved name is the
 * profile name used by the account menu (chat greeting wires up as the
 * surfaces adopt it); React escapes it everywhere it renders.
 */
export function WelcomeIntro(props: { onDone: () => void }): ReactElement {
	const sessionName = useSessionName();
	const reduceMotion =
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	const LINES: { text: string; mood: MascotMood }[] = [
		{ text: 'Hi — I\u2019m Caddie.', mood: 'ready' },
		{ text: 'I read the rules, draft the plan, and build it.', mood: 'thinking' },
		{ text: 'You approve every step, and I ask before spending anything.', mood: 'done' },
	];

	const [line, setLine] = useState(reduceMotion ? LINES.length - 1 : 0);
	useEffect(() => {
		if (reduceMotion || line >= LINES.length - 1) return;
		const timer = window.setTimeout(() => setLine((value) => value + 1), 1500);
		return () => window.clearTimeout(timer);
	}, [line, reduceMotion, LINES.length]);

	const [stage, setStage] = useState<'intro' | 'name' | 'faces'>('intro');
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
			<section className="card-surface start-card welcome-intro" data-testid="welcome-intro">
				<span className="welcome-intro-face" aria-hidden="true">
					<Mascot mood={LINES[line]!.mood} size={64} live />
				</span>
				<div aria-live="polite">
					{LINES.slice(0, line + 1).map((entry) => (
						<p key={entry.text} className="start-lede">
							{entry.text}
						</p>
					))}
				</div>
				<div className="row-actions">
					<button
						type="button"
						className="btn-key"
						data-testid="welcome-next"
						onClick={() => setStage('name')}
					>
						Next
					</button>
					<button
						type="button"
						className="btn-ghost"
						data-testid="welcome-replay"
						onClick={() => setLine(reduceMotion ? LINES.length - 1 : 0)}
					>
						Say that again
					</button>
				</div>
			</section>
		);
	}

	if (stage === 'name') {
		return (
			<section className="card-surface start-card welcome-intro" data-testid="welcome-name">
				<span className="welcome-intro-face" aria-hidden="true">
					<Mascot mood="listening" size={64} live />
				</span>
				<h3 className="start-card-title">What should I call you?</h3>
				{sessionName ? (
					<p className="state-detail">From your account. Change it if you like.</p>
				) : (
					<p className="state-detail">Caddie greets you by this name.</p>
				)}
				<input
					className="input"
					data-testid="welcome-name-input"
					value={name}
					maxLength={40}
					onChange={(event) => setName(event.target.value)}
				/>
				{usernameHint ? (
					<p className="state-detail">Your account name looks like a username, so I left this blank.</p>
				) : null}
				<div className="row-actions">
					<button
						type="button"
						className="btn-key"
						data-testid="welcome-name-save"
						onClick={() => {
							saveProfileName(name);
							setStage('faces');
						}}
					>
						Continue
					</button>
					<button
						type="button"
						className="btn-ghost"
						data-testid="welcome-name-skip"
						onClick={() => {
							saveProfileName('');
							setStage('faces');
						}}
					>
						Skip — I&rsquo;ll add it later
					</button>
				</div>
			</section>
		);
	}

	return (
		<section className="card-surface start-card welcome-intro" data-testid="welcome-faces">
			<div className="welcome-faces">
				<span className="welcome-face">
					<Mascot mood="building" size={56} live />
					<b>Building</b>
					<small>Caddie writes the code</small>
				</span>
				<span className="welcome-face">
					<Mascot mood="needs" size={56} live />
					<b>Needs you</b>
					<small>A plan waits for your OK</small>
				</span>
				<span className="welcome-face">
					<Mascot mood="done" size={56} live />
					<b>Done</b>
					<small>You can try what it built</small>
				</span>
			</div>
			<div className="row-actions">
				<button type="button" className="btn-key" data-testid="welcome-go" onClick={props.onDone}>
					Let&rsquo;s go
				</button>
			</div>
		</section>
	);
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
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
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
				workspaceId: chrome.homeProject?.workspaceId,
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
