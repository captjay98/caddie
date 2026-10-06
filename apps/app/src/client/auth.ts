import { createAuthClient } from 'better-auth/client';
import { createElement, useCallback, useState, type ReactElement } from 'react';

/**
 * P01 client identity: sign-in panel for the Caddie SPA.
 *
 * Two social providers (Google and GitHub), a visible error state with an
 * explicit retry, and a pending state — the P01 slice-3 requirement. The file
 * is plain TypeScript on purpose (no JSX) so it stays a single packet-owned
 * file; elements are built with `createElement`.
 *
 * The Better Auth client is same-origin by default (`/api/auth`), matching the
 * Worker mount in apps/app/src/app.ts. Sessions are cookie-based; nothing here
 * ever handles secrets.
 */

export const authClient = createAuthClient();

const DEFAULT_CALLBACK_URL = '/app/';

export type SocialProvider = 'google' | 'github';

const PROVIDERS: { id: SocialProvider; label: string }[] = [
	{ id: 'google', label: 'Continue with Google' },
	{ id: 'github', label: 'Continue with GitHub' },
];

interface SignInErrorView {
	title: string;
	detail: string;
}

function toErrorView(provider: SocialProvider, status: number | undefined, message: string | undefined): SignInErrorView {
	const label = provider === 'google' ? 'Google' : 'GitHub';
	if (status === 503) {
		return {
			title: `Sign-in with ${label} is unavailable`,
			detail:
				message ??
				'Authentication is not configured on this deployment yet. Once the owner sets the sign-in credentials, try again.',
		};
	}
	return {
		title: `Sign-in with ${label} failed`,
		detail: message ? 'The sign-in attempt was rejected — you can retry below.' : 'Something went wrong — you can retry below.',
	};
}

export interface SignInPanelProps {
	callbackURL?: string;
}

/** Sign-in panel: one button per provider, visible error + retry states. */
export function SignInPanel(props: SignInPanelProps = {}): ReactElement {
	const callbackURL = props.callbackURL ?? DEFAULT_CALLBACK_URL;
	const [pending, setPending] = useState<SocialProvider | null>(null);
	const [error, setError] = useState<{ provider: SocialProvider; view: SignInErrorView } | null>(null);

	const signIn = useCallback(
		async (provider: SocialProvider) => {
			setError(null);
			setPending(provider);
			try {
				const result = await authClient.signIn.social({ provider, callbackURL });
				if (result.error) {
					setError({
						provider,
						view: toErrorView(provider, result.error.status, result.error.message || undefined),
					});
					return;
				}
				const url = result.data?.url;
				if (url) {
					// configured deployment: continue to the provider authorization page
					window.location.assign(url);
				} else {
					setError({ provider, view: toErrorView(provider, undefined, undefined) });
				}
			} catch {
				// network/transport failure — always surfaced, never swallowed
				setError({ provider, view: toErrorView(provider, undefined, undefined) });
			} finally {
				setPending(null);
			}
		},
		[callbackURL],
	);

	return createElement(
		'section',
		{ 'data-testid': 'sign-in-panel', 'aria-label': 'Sign in' },
		PROVIDERS.map(({ id, label }) =>
			createElement(
				'button',
				{
					key: id,
					type: 'button',
					className: 'btn-ghost sign-in-btn',
					'data-testid': `sign-in-${id}`,
					'data-provider': id,
					disabled: pending !== null,
					onClick: () => void signIn(id),
				},
				pending === id ? 'Signing in…' : label,
			),
		),
		error
			? createElement(
					'p',
					{
						key: 'error',
						role: 'alert',
						className: 'sign-in-error',
						'data-testid': 'sign-in-error',
					},
					`${error.view.title}: ${error.view.detail} `,
					createElement(
						'button',
						{
							type: 'button',
							className: 'btn-ghost',
							'data-testid': 'sign-in-retry',
							onClick: () => void signIn(error.provider),
						},
						'Try again',
					),
				)
			: null,
	);
}
