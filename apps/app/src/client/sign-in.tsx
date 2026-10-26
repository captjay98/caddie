import type { ReactElement } from 'react';
import { Mascot } from '@caddie/ui/Mascot';
import { SignInPanel } from './auth.ts';

/**
 * The one sign-in screen (plan 5.2; calm redo 2026-10-25). Every signed-out
 * way in renders this one component (the workspace chrome, any page body and
 * the onboarding page), so a person never meets two different sign-ins.
 *
 * It does one job: let you in. A small mascot, one heading, one line saying
 * what Caddie is, the providers (with the judge door as a quiet link), and an
 * honest access line — Caddie is invite-only, so it never says "free to start".
 * The landing page does the explaining; this page does not repeat it.
 */
export function SignInScreen({ callbackURL = '/app/' }: { callbackURL?: string }): ReactElement {
	return (
		<div className="signin-screen" data-testid="sign-in-gate">
			<div className="signin-col">
				<div className="signin-brand">
					<Mascot mood="ready" size={56} live />
					<h1 className="signin-title">Sign in to start building</h1>
					{/* Two unbreakable phrases: when it must wrap, it breaks at the dash. */}
					<p className="signin-lede">
						<span className="signin-nobreak">Build an app from your idea&nbsp;—</span>{' '}
						<span className="signin-nobreak">no coding needed.</span>
					</p>
				</div>
				<div className="signin-card">
					<SignInPanel callbackURL={callbackURL} />
				</div>
				<p className="signin-note" data-testid="sign-in-access-note">
					Caddie is invite-only during the hackathon.
				</p>
			</div>
		</div>
	);
}
