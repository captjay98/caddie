import { createAuthClient } from 'better-auth/client';
import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react';

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

/**
 * Official provider marks (Google four-color "G", GitHub octocat mark) as
 * inline SVG — no CDN fetches, consistent with the self-hosted asset rule.
 * Google keeps its brand colors on any theme; GitHub follows currentColor so
 * it reads on both halo themes.
 */
function providerIcon(id: SocialProvider): ReactElement {
	if (id === 'google') {
		return createElement(
			'svg',
			{ width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true },
			createElement('path', {
				fill: '#4285F4',
				d: 'M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z',
			}),
			createElement('path', {
				fill: '#34A853',
				d: 'M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26a5.4 5.4 0 0 1-8.09-2.85H.96v2.33A9 9 0 0 0 9 18z',
			}),
			createElement('path', {
				fill: '#FBBC05',
				d: 'M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z',
			}),
			createElement('path', {
				fill: '#EA4335',
				d: 'M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3 2.33A5.36 5.36 0 0 1 9 3.58z',
			}),
		);
	}
	return createElement(
		'svg',
		{ width: 18, height: 18, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
		createElement('path', {
			d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z',
		}),
	);
}

interface SignInErrorView {
	title: string;
	detail: string;
	/** Whether retrying the same provider can ever succeed. */
	retryable: boolean;
}

function toErrorView(provider: SocialProvider, status: number | undefined, message: string | undefined): SignInErrorView {
	const label = provider === 'google' ? 'Google' : 'GitHub';
	if (status === 503) {
		return {
			title: `Sign-in with ${label} is unavailable`,
			detail:
				message ??
				'Authentication is not configured on this deployment yet, so retrying the same provider cannot succeed until its credentials exist.',
			retryable: false,
		};
	}
	return {
		title: `Sign-in with ${label} failed`,
		detail: message ? 'The sign-in attempt was rejected — you can retry below.' : 'Something went wrong — you can retry below.',
		retryable: true,
	};
}

interface IntegrationsHealth {
	auth: { providers: { google: boolean; github: boolean } };
}

export interface SignInPanelProps {
	callbackURL?: string;
}

/**
 * Sign-in panel: one button per provider, provider availability stated BEFORE
 * the first click (the server's configured/not-configured presence, read from
 * /api/integrations/health — the same source Settings renders), and a failure
 * that separates reason, consequence and action: a rejected attempt keeps
 * Try again; a 503 "not configured on this deployment" is terminal and offers
 * the other provider instead (UI review board screen 02).
 */
export function SignInPanel(props: SignInPanelProps = {}): ReactElement {
	const callbackURL = props.callbackURL ?? DEFAULT_CALLBACK_URL;
	const [pending, setPending] = useState<SocialProvider | null>(null);
	const [error, setError] = useState<{ provider: SocialProvider; view: SignInErrorView } | null>(null);
	const [availability, setAvailability] = useState<{ google: boolean; github: boolean } | null>(null);

	// Presence check — name and pair only, never the values. Failure to read it
	// keeps every provider enabled: unknown availability must not block a sign-in.
	useEffect(() => {
		let cancelled = false;
		void fetch('/api/integrations/health')
			.then((res) => (res.ok ? (res.json() as Promise<IntegrationsHealth>) : null))
			.then((health) => {
				if (!cancelled && health) {
					setAvailability(health.auth.providers);
				}
			})
			.catch(() => {
				// availability unknown — leave buttons enabled
			});
		return () => {
			cancelled = true;
		};
	}, []);

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

	const otherProvider: SocialProvider | null =
		error && availability
			? (error.provider === 'google' ? 'github' : 'google')
			: null;
	const otherAvailable = otherProvider !== null && availability ? availability[otherProvider] : false;

	return createElement(
		'section',
		{ 'data-testid': 'sign-in-panel', 'aria-label': 'Sign in' },
		PROVIDERS.map(({ id, label }) => {
			const configured = availability === null ? true : availability[id];
			return createElement(
				'div',
				{ key: id, className: 'sign-in-provider' },
				createElement(
					'button',
					{
						type: 'button',
						className: 'btn-ghost sign-in-btn',
						'data-testid': `sign-in-${id}`,
						'data-provider': id,
						disabled: pending !== null || !configured,
						onClick: () => void signIn(id),
					},
					providerIcon(id),
					createElement('span', { key: 'label' }, pending === id ? 'Signing in…' : label),
				),
				createElement(
					'span',
					{
						key: 'state',
						className: 'status-pill',
						'data-status': configured ? 'handled' : 'planned',
						'data-testid': `sign-in-${id}-state`,
						title:
							'availability is read from this deployment before you click — so a sign-in button is never offered when it cannot work',
					},
					availability === null ? 'checking…' : configured ? 'ready' : 'not set up yet',
				),
			);
		}),
		availability !== null
			? createElement(
					'p',
					{ key: 'presence', className: 'mono-id sign-in-presence', 'data-testid': 'sign-in-presence' },
					'Both options are checked before you click — a sign-in button is never offered when it cannot work.',
				)
			: null,
		error
			? createElement(
					'div',
					{
						key: 'error',
						role: 'alert',
						className: 'sign-in-error',
						'data-testid': 'sign-in-error',
					},
					createElement('b', null, `${error.view.title}.`),
					createElement('span', null, ` ${error.view.detail}`),
					error.view.retryable
						? createElement(
								'button',
								{
									type: 'button',
									className: 'btn-ghost',
									'data-testid': 'sign-in-retry',
									onClick: () => void signIn(error.provider),
								},
								'Try again',
							)
						: otherProvider && otherAvailable
							? createElement(
									'button',
									{
										type: 'button',
										className: 'btn-key',
										'data-testid': 'sign-in-other',
										onClick: () => void signIn(otherProvider),
									},
									`Continue with ${otherProvider === 'google' ? 'Google' : 'GitHub'} instead`,
								)
							: null,
				)
			: null,
	);
}
