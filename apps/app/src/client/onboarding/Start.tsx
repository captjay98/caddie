import type { ReactElement } from 'react';

/**
 * P14 onboarding entry — three cards for the three ways to start (feature
 * ledger: onboarding paths). Honesty rules:
 *
 *   - "Start from an idea" routes into the workspace, where creating a
 *     project from an idea exists today (P02/P06 surface).
 *   - "Start from a GitHub repo" and "Start from discovery" are PLANNED
 *     capabilities (P08 GitHub integration, P11 discovery). They render as
 *     visibly unavailable cards with the packet that will ship them — never
 *     as buttons that pretend to work.
 *   - There is NO complete-profile wall before useful work: the profile is
 *     optional and lives in Settings.
 */

function StartCard(props: {
	testId: string;
	kicker: string;
	title: string;
	detail: string;
	action?: ReactElement;
	comingWith?: string;
}): ReactElement {
	return (
		<section className="card-surface" data-testid={props.testId} data-coming-with={props.comingWith ?? undefined}>
			<p className="kicker" data-tone={props.comingWith ? 'stale' : 'action'}>
				{props.kicker}
			</p>
			<h3 className="state-title">{props.title}</h3>
			<p className="state-detail">{props.detail}</p>
			{props.comingWith ? (
				<p className="status-pill" data-status="blocked">
					Planned — arrives with {props.comingWith}
				</p>
			) : null}
			{props.action ? <div className="card-details">{props.action}</div> : null}
		</section>
	);
}

export function Start(props: { onStartIdea?: () => void } = {}): ReactElement {
	return (
		<main className="shell-loading" id="main" data-testid="start-screen">
			<p className="kicker" data-tone="action">
				CADDIE · GET STARTED
			</p>
			<h1 className="state-title">How do you want to start?</h1>
			<p className="state-detail">
				All three paths lead to the same workspace. Your profile (country,
				timezone, hours, stacks) is optional and can be filled in later under
				Settings — it is never required before useful work.
			</p>
			<div className="card-stack">
				<StartCard
					testId="start-card-idea"
					kicker="FROM AN IDEA"
					title="Start from an idea"
					detail="Describe what you want to build; Caddie helps you turn it into a project, a plan and runnable work."
					action={
						props.onStartIdea ? (
							<button
								type="button"
								className="btn-key"
								data-testid="start-idea-go"
								onClick={props.onStartIdea}
							>
								Start from an idea
							</button>
						) : (
							<a className="btn-key" href="./" data-testid="start-idea-go">
								Open the workspace
							</a>
						)
					}
				/>
				<StartCard
					testId="start-card-repo"
					kicker="FROM A REPO"
					title="Start from a GitHub repository"
					detail="Point Caddie at an existing repository and build on top of it."
					comingWith="P08 (GitHub integration)"
				/>
				<StartCard
					testId="start-card-discovery"
					kicker="FROM DISCOVERY"
					title="Start from a contest pick"
					detail="Browse curated hackathon discovery and start a project from a validated candidate."
					comingWith="P11 (discovery)"
				/>
			</div>
		</main>
	);
}
