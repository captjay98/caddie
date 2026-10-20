import type { ReactElement } from 'react';
import { Mascot } from '@caddie/ui/Mascot';
import { SignInPanel } from './auth.ts';

/**
 * The one sign-in screen (plan 5.2): Caddie and what it does on the left, the
 * real sign-in form on the right; on a phone, the form alone. Every signed-out
 * way in renders this one component (the workspace chrome, any page body and
 * the onboarding page), so a person never meets two different sign-ins.
 */
export function SignInScreen({ callbackURL = '/app/' }: { callbackURL?: string }): ReactElement {
	return (
		<div className="signin-split" data-testid="sign-in-gate">
			{/* LEFT: brand / mascot hero — a signed-out screen has no live session,
			    so this is an honest static hero (what Caddie does), never a faked
			    live feed. Themed entirely via tokens so it tracks mode + palette. */}
			<div className="signin-hero" aria-hidden="true">
				<div className="signin-hero-grid" />
				<p className="signin-hero-brand">CADDIE</p>
				<div className="signin-hero-center">
					<Mascot mood="ready" size={88} live />
					<div className="signin-hero-copy">
						<h2 className="signin-hero-title">Your caddie for the whole round.</h2>
						<p className="signin-hero-lede">
							Caddie finds the hackathons that fit you, plans the build, and ships it with you — step by
							step, nothing without your say-so.
						</p>
					</div>
					<ul className="signin-hero-chips">
						<li>Finds contests</li>
						<li>Plans the build</li>
						<li>Ships with you</li>
					</ul>
				</div>
				<p className="signin-hero-foot">Built for solo builders. Free to start.</p>
			</div>

			{/* RIGHT: the real sign-in form, vertically centered. */}
			<div className="signin-form">
				<div className="signin-col">
					<div className="signin-brand">
						<h1 className="signin-title">Sign in to Caddie</h1>
						<p className="signin-lede">Use the account you already have — it&rsquo;s free to start.</p>
					</div>
					<div className="signin-card">
						<SignInPanel callbackURL={callbackURL} />
					</div>
					<p className="signin-note">
						Signing in doesn&rsquo;t give Caddie your code. It asks separately, only if you bring code in.
					</p>
				</div>
			</div>
		</div>
	);
}
