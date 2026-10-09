import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCreateProject } from '../queries.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';

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
					<li><span className="loop-step">Plan</span> — you approve it</li>
					<li><span className="loop-step">Build</span> — Caddie writes it</li>
					<li><span className="loop-step">Prove</span> — evidence kept</li>
					<li><span className="loop-step">Ship</span> — you submit</li>
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
