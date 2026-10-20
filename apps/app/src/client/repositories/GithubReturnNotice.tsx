import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { githubReturnWords, takeGithubReturn, type GithubReturnOutcome } from '../github-return.ts';
import { sessionShareStorage } from '../share-target.ts';

/**
 * What GitHub's return came to, said once at the top of the page (plan 6.1).
 * share-capture.ts took `?github=` out of the address before the router read
 * it; this hands the waiting outcome over once, so a reload never repeats it.
 */
export function GithubReturnNotice(): ReactElement | null {
	const [outcome, setOutcome] = useState<GithubReturnOutcome | null>(null);
	useEffect(() => {
		const taken = takeGithubReturn(sessionShareStorage());
		if (taken) setOutcome(taken);
	}, []);
	if (!outcome) return null;
	const words = githubReturnWords(outcome);
	return (
		<div
			className="github-return"
			role={words.tone === 'ok' ? 'status' : 'alert'}
			data-testid="github-return"
			data-outcome={outcome}
			data-tone={words.tone}
		>
			<p className="github-return-text">
				<b>{words.title}</b> {words.detail}
			</p>
			<button type="button" className="btn-ghost" data-testid="github-return-dismiss" onClick={() => setOutcome(null)}>
				Dismiss
			</button>
		</div>
	);
}
