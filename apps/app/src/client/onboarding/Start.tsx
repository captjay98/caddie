import type { ReactElement } from 'react';

/**
 * P14 onboarding entry — three cards for the three ways to start (feature
 * ledger: onboarding paths). Honesty rules:
 *
 *   - "Start from an idea" routes into the workspace, where creating a
 *     project from an idea exists today (P02/P06 surface).
 *   - "Start from discovery" is the P11 discovery surface — it EXISTS now
 *     (browse candidates with evidence-backed fit/eligibility, accept onto a
 *     shortlist), so its card is a real link. Creating a project FROM an
 *     accepted candidate is not wired yet; the card copy says only what the
 *     surface really does.
 *   - "Start from a GitHub repo" is a PLANNED capability (P08 GitHub
 *     integration). It renders as a visibly unavailable card that names the
 *     unlock in the visitor's terms ("needs a repository connection") and
 *     links to the repository surface — never a button that pretends to work,
 *     and never an internal packet id (UI review board screen 03).
 *   - There is NO complete-profile wall before useful work: the profile is
 *     optional and lives in Settings.
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
		<section className="card-surface" data-testid={props.testId}>
			<p className="kicker" data-tone={props.planned ? 'planned' : 'action'}>
				{props.kicker}
			</p>
			<h3 className="state-title">{props.title}</h3>
			<p className="state-detail">{props.detail}</p>
			{props.planned ? (
				<p className="status-pill" data-status="planned">
					Planned — needs a repository connection
				</p>
			) : null}
			{props.action ? <div className="card-details">{props.action}</div> : null}
		</section>
	);
}

export function Start(props: { onStartIdea?: () => void } = {}): ReactElement {
	return (
		<div className="shell-loading" data-testid="start-screen">
			<div className="start-stack">
				<p className="kicker" data-tone="action">
					CADDIE · GET STARTED
				</p>
				<h1 className="state-title">What are you building?</h1>
				<p className="state-detail">
					All three paths lead to the same workspace. Your profile (country,
					timezone, hours, stacks) is optional and can be filled in later under
					Settings — it is never required before useful work.
				</p>
				<div className="card-stack">
					<StartCard
						testId="start-card-idea"
						kicker="DESCRIBE AN IDEA"
						title="Start from an idea"
						detail="Caddie drafts a plan revision, pins every claim to a source, and stops at the design gate before anything gets built."
						action={
							props.onStartIdea ? (
								<button
									type="button"
									className="btn-key"
									data-testid="start-idea-go"
									onClick={props.onStartIdea}
								>
									Create the first plan
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
						detail="Arrives with the GitHub App connection. Until then this card has no action — it is not a button that pretends to work."
						planned
						action={
							<a className="r-link" href="./repositories" data-testid="start-repo-go">
								See what the connection will ask for
							</a>
						}
					/>
					<StartCard
						testId="start-card-discovery"
						kicker="FROM DISCOVERY"
						title="Start from a contest pick"
						detail="Browse curated hackathon discovery — every fit claim carries its evidence, and accepting a candidate keeps it on your shortlist."
						action={
							<a className="btn-key" href="./discovery" data-testid="start-discovery-go">
								Browse discovery now
							</a>
						}
					/>
				</div>
			</div>
		</div>
	);
}