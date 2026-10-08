import type { ReactElement } from 'react';

/**
 * P14 onboarding entry — three cards for the three ways to start (feature
 * ledger: onboarding paths), written for someone who has never heard of
 * evidence-backed build agents (reference: hacksteward's onboarding wizard —
 * plain first-person choices; the reference caddie's voice).
 *
 * Honesty rules, translated into product language:
 *   - "Start from an idea" is the ready path: Caddie writes a plan you can
 *     review, and nothing gets built until you approve it.
 *   - "Start from discovery" EXISTS now — real links, real copy about what
 *     the surface does.
 *   - "Start from a GitHub repo" is PLANNED. The card says what it will do
 *     and what is missing, in the visitor's terms — never an internal packet
 *     id, never reviewer-speak, never a button that looks dead for no reason.
 *   - No profile wall: the profile is optional and lives in Settings.
 *
 * Rendered inside WorkspaceChrome on both entry points (the zero-project
 * workspace branch and /onboarding), so it never opens its own `<main>`.
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

export function Start(props: { onStartIdea?: () => void } = {}): ReactElement {
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
			</header>
			<div className="start-cards">
				<StartCard
					testId="start-card-idea"
					kicker="START WITH AN IDEA"
					title="Describe what you want to build"
					detail="Tell Caddie your idea in plain words. It writes a step-by-step plan, shows you where every fact came from, and waits for your approval before building anything."
					action={
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
							<a className="btn-key" href="./" data-testid="start-idea-go">
								Open the workspace
							</a>
						)
					}
				/>
				<StartCard
					testId="start-card-discovery"
					kicker="OR START FROM A HACKATHON"
					title="Pick a contest Caddie found for you"
					detail="Browse real hackathons with the deadlines, the rules, and why each one fits you — every claim links to its source, and saving one keeps it on your shortlist."
					action={
						<a className="btn-key" href="./discovery" data-testid="start-discovery-go">
							Browse hackathons
						</a>
					}
				/>
				<StartCard
					testId="start-card-repo"
					kicker="START FROM YOUR OWN CODE"
					title="Build on top of a GitHub repository"
					detail="Connect your GitHub and Caddie can work on code you already have. This one isn't connected yet — the moment it is, this card becomes a real starting point."
					planned
					action={
						<a className="r-link" href="./repositories" data-testid="start-repo-go">
							See what the connection will ask for
						</a>
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