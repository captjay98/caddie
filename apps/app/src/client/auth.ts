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

/**
 * Map an OAuth-callback `?error=<code>` (set by the server when the callback
 * itself fails, e.g. the invite gate) to a friendly, styled notice. These are
 * failures that happen AFTER the provider round-trip, so they arrive as a URL
 * param on return — not as a `signIn.social` result. Unknown codes get an
 * honest generic message rather than the raw code.
 */
function callbackErrorView(code: string, description: string | null): SignInErrorView {
	if (code === 'INVITE_REQUIRED') {
		return {
			title: 'You need an invite to sign in',
			detail:
				'Caddie is invite-only right now, and this email isn’t on the allowlist yet. Ask for an invite, then sign in with the same email.',
			retryable: false,
		};
	}
	return {
		title: 'Sign-in couldn’t be completed',
		detail: description?.trim()
			? description.trim()
			: 'The sign-in attempt was rejected on return from the provider — you can try again.',
		retryable: true,
	};
}

/**
 * S06 judge access: whether judges can get in on this deployment, and whether
 * NEW judge accounts can still be started. `canStart` is false once judge
 * access has been switched off for new judges — returning judges can still
 * sign in.
 */
export interface JudgeAccess {
	open: boolean;
	canStart: boolean;
}

interface JudgeRefusalBody {
	error?: unknown;
	message?: unknown;
}

/**
 * POST one judge endpoint and return either success or the sentence to show.
 * The server writes a plain sentence into `message` for every refusal; the
 * panel renders that sentence VERBATIM — it never rephrases a refusal the
 * server explained and never echoes an HTTP status. Only a refusal with no
 * sentence (or a request that never reached the server) gets the panel's own
 * honest fallback line.
 */
async function postJudge(path: string, payload: Record<string, string>): Promise<{ ok: true } | { ok: false; message: string }> {
	let response: Response;
	try {
		response = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});
	} catch {
		return { ok: false, message: 'We couldn’t reach Caddie just now. Check your connection and try again.' };
	}
	if (response.ok) return { ok: true };
	let message = '';
	try {
		const body = (await response.json()) as JudgeRefusalBody;
		if (typeof body.message === 'string' && body.message.trim() !== '') message = body.message.trim();
	} catch {
		// non-JSON refusal — fall through to the honest generic line
	}
	return { ok: false, message: message || 'That didn’t work. Please try again.' };
}

/** One labelled judge field. The label carries the hint so the field reads as one thing. */
function judgeField(props: {
	testId: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	type?: string;
	autoComplete?: string;
	hint?: string;
}): ReactElement {
	return createElement(
		'label',
		{ key: props.testId, className: 'judge-field', style: { display: 'grid', gap: '0.25rem' } },
		createElement('span', { key: 'label' }, props.label),
		createElement('input', {
			key: 'input',
			className: 'input',
			'data-testid': props.testId,
			type: props.type ?? 'text',
			autoComplete: props.autoComplete,
			value: props.value,
			// Not a hard `minLength`: the server owns the password rule and its
			// plain sentence is what a too-short password must show.
			onChange: (event: { target: { value: string } }) => props.onChange(event.target.value),
		}),
		props.hint ? createElement('small', { key: 'hint', className: 'sign-in-unavailable-note' }, props.hint) : null,
	);
}

/**
 * The judge door, added beside the providers. Collapsed it is one quiet link
 * ("Judging the hackathon? Use your access code"); open it offers the
 * first-visit form (access code + judge name + password) and, for someone who
 * judged before, name + password. Access is read once from
 * `GET /api/judge/access`; an unknown or failed read is treated as CLOSED and
 * no judge option is shown — an older build without the endpoint must not
 * surface a control that cannot work.
 */
export function JudgeAccessBlock(props: { callbackURL: string }): ReactElement | null {
	const [access, setAccess] = useState<JudgeAccess | null>(null);
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<'start' | 'sign-in'>('start');
	const [code, setCode] = useState('');
	const [name, setName] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void fetch('/api/judge/access')
			.then((res) => (res.ok ? (res.json() as Promise<Partial<JudgeAccess>>) : null))
			.then((body) => {
				if (!cancelled && body) {
					setAccess({ open: body.open === true, canStart: body.canStart === true });
				}
			})
			.catch(() => {
				// judge access unknown — leave it closed, show no judge option
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (access?.open !== true) return null;

	const canStart = access.canStart === true;
	const showingSignIn = !canStart || mode === 'sign-in';

	async function startJudging() {
		if (busy) return;
		setBusy(true);
		setError(null);
		const result = await postJudge('/api/judge/start', { code, name, password });
		if (result.ok) {
			// The server set a session cookie. Reload into the app the same way
			// the OAuth callback returns, so the onboarding gate sees the new
			// judge session exactly as it would any other signed-in arrival.
			window.location.assign(props.callbackURL);
			return;
		}
		setError(result.message);
		setBusy(false);
	}

	async function signInAsJudge() {
		if (busy) return;
		setBusy(true);
		setError(null);
		// The server maps a judge name to its synthetic address; the client never
		// builds or sends an email.
		const result = await postJudge('/api/judge/sign-in', { name, password });
		if (result.ok) {
			window.location.assign(props.callbackURL);
			return;
		}
		setError(result.message);
		setBusy(false);
	}

	if (!open) {
		return createElement(
			'button',
			{
				type: 'button',
				className: 'btn-ghost judge-link',
				'data-testid': 'judge-link',
				onClick: () => {
					setOpen(true);
					setError(null);
				},
			},
			'Judging the hackathon? Use your access code',
		);
	}

	const form = showingSignIn
		? createElement(
				'form',
				{
					key: 'sign-in',
					'data-testid': 'judge-sign-in-form',
					style: { display: 'grid', gap: '0.6rem' },
					onSubmit: (event: { preventDefault: () => void }) => {
						event.preventDefault();
						void signInAsJudge();
					},
				},
				judgeField({ testId: 'judge-name', label: 'Judge name', value: name, onChange: setName, autoComplete: 'username' }),
				judgeField({ testId: 'judge-password', label: 'Password', value: password, onChange: setPassword, type: 'password', autoComplete: 'current-password' }),
				createElement(
					'button',
					{ key: 'submit', type: 'submit', className: 'btn-key', 'data-testid': 'judge-sign-in', disabled: busy },
					busy ? 'Signing in…' : 'Sign in as a judge',
				),
			)
		: createElement(
				'form',
				{
					key: 'start',
					'data-testid': 'judge-start-form',
					style: { display: 'grid', gap: '0.6rem' },
					onSubmit: (event: { preventDefault: () => void }) => {
						event.preventDefault();
						void startJudging();
					},
				},
				judgeField({ testId: 'judge-code', label: 'Access code', value: code, onChange: setCode, autoComplete: 'off' }),
				judgeField({ testId: 'judge-name', label: 'Judge name', value: name, onChange: setName, autoComplete: 'username', hint: 'Letters, numbers and dashes.' }),
				judgeField({ testId: 'judge-password', label: 'Password', value: password, onChange: setPassword, type: 'password', autoComplete: 'new-password', hint: 'At least 10 characters.' }),
				createElement(
					'button',
					{ key: 'submit', type: 'submit', className: 'btn-key', 'data-testid': 'judge-start', disabled: busy },
					busy ? 'Starting…' : 'Start judging',
				),
			);

	return createElement(
		'div',
		{
			'data-testid': 'judge-panel',
			style: { display: 'grid', gap: '0.6rem', marginTop: '1rem', textAlign: 'left' },
		},
		!canStart
			? createElement(
					'p',
					{ key: 'closed', className: 'sign-in-unavailable-note', 'data-testid': 'judge-closed' },
					'New judge places aren’t open right now. Sign in if you already have a judge account.',
				)
			: null,
		form,
		error
			? createElement(
					'div',
					{ key: 'error', role: 'alert', className: 'sign-in-error', 'data-testid': 'judge-error' },
					error,
				)
			: null,
		canStart && !showingSignIn
			? createElement(
					'button',
					{
						key: 'returning',
						type: 'button',
						className: 'btn-ghost judge-link',
						'data-testid': 'judge-returning-link',
						onClick: () => {
							setMode('sign-in');
							setError(null);
						},
					},
					'Sign in as a judge',
				)
			: null,
		canStart && showingSignIn
			? createElement(
					'button',
					{
						key: 'new',
						type: 'button',
						className: 'btn-ghost judge-link',
						'data-testid': 'judge-new-link',
						onClick: () => {
							setMode('start');
							setError(null);
						},
					},
					'First time judging? Use your access code',
				)
			: null,
	);
}

export interface SignInPanelProps {
	callbackURL?: string;
}

/**
 * Sign-in panel: one button per provider. Availability is read from this
 * deployment (/api/integrations/health, the same source Settings renders)
 * before the first click, but it is expressed through the control itself
 * rather than a status label: a provider that cannot work is blurred and
 * inert, and when neither provider is configured the buttons are replaced by
 * a clear message. A failure separates reason, consequence and action — a
 * rejected attempt keeps Try again; a 503 "not configured on this deployment"
 * is terminal and offers the other provider instead.
 */
export function SignInPanel(props: SignInPanelProps = {}): ReactElement {
	const callbackURL = props.callbackURL ?? DEFAULT_CALLBACK_URL;
	const [pending, setPending] = useState<SocialProvider | null>(null);
	const [error, setError] = useState<{ provider: SocialProvider; view: SignInErrorView } | null>(null);
	const [callbackError, setCallbackError] = useState<SignInErrorView | null>(null);
	const [availability, setAvailability] = useState<{ google: boolean; github: boolean } | null>(null);

	// Read an OAuth-callback error returned as ?error=<code> (e.g. the invite
	// gate). Render it as a styled notice, then strip the params from the URL so
	// a refresh does not keep showing a stale error.
	useEffect(() => {
		if (typeof window === 'undefined') return;
		const params = new URLSearchParams(window.location.search);
		const code = params.get('error');
		if (!code) return;
		setCallbackError(callbackErrorView(code, params.get('error_description')));
		params.delete('error');
		params.delete('error_description');
		const qs = params.toString();
		const cleaned = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
		window.history.replaceState(null, '', cleaned);
	}, []);

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
			setCallbackError(null);
			setPending(provider);
			try {
				const result = await authClient.signIn.social({
					provider,
					callbackURL,
					// On a callback-side failure (e.g. the invite gate rejects an
					// uninvited email), better-auth redirects HERE with ?error=<code>
					// instead of showing its own unstyled error page. The panel reads
					// that param on mount and renders a friendly, in-app notice.
					errorCallbackURL: callbackURL,
				});
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

	// Availability is read from this deployment (/api/integrations/health) before
	// the first click. A provider that cannot work is blurred and inert rather
	// than offered as a button that is guaranteed to fail. When NEITHER provider
	// is configured there is nothing to click, so the buttons are replaced by a
	// clear message. Unknown availability (null) keeps everything enabled.
	const neitherConfigured = availability !== null && !availability.google && !availability.github;

	return createElement(
		'section',
		{ 'data-testid': 'sign-in-panel', 'aria-label': 'Sign in' },
		neitherConfigured
			? createElement(
					'p',
					{
						key: 'none',
						role: 'status',
						className: 'sign-in-none',
						'data-testid': 'sign-in-unavailable',
					},
					createElement('b', { key: 't' }, 'Sign-in isn’t set up on this deployment yet.'),
					createElement(
						'span',
						{ key: 'd' },
						' Neither Google nor GitHub has been configured here, so there’s nothing to sign in with for now.',
					),
				)
			: PROVIDERS.map(({ id, label }) => {
					const configured = availability === null ? true : availability[id];
					return createElement(
						'div',
						{
							key: id,
							className: configured ? 'sign-in-provider' : 'sign-in-provider is-unavailable',
							'data-testid': `sign-in-${id}-row`,
							'data-available': configured ? 'yes' : 'no',
						},
						createElement(
							'button',
							{
								type: 'button',
								className: 'btn-ghost sign-in-btn',
								'data-testid': `sign-in-${id}`,
								'data-provider': id,
								disabled: pending !== null || !configured,
								'aria-hidden': configured ? undefined : true,
								tabIndex: configured ? undefined : -1,
								onClick: () => void signIn(id),
							},
							providerIcon(id),
							createElement('span', { key: 'label' }, pending === id ? 'Signing in…' : label),
						),
						configured
							? null
							: createElement(
									'span',
									{ key: 'why', className: 'sign-in-unavailable-note' },
									'Not set up on this deployment yet',
								),
					);
				}),
		callbackError
			? createElement(
					'div',
					{
						key: 'callback-error',
						role: 'alert',
						className: 'sign-in-error',
						'data-testid': 'sign-in-callback-error',
					},
					createElement('b', null, `${callbackError.title}.`),
					createElement('span', null, ` ${callbackError.detail}`),
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
		// The judge door (S06) sits quietly beside the providers. It reads its
		// own availability and renders nothing when judge access is off or
		// unknown — including on an older build with no /api/judge/access.
		createElement(JudgeAccessBlock, { key: 'judge', callbackURL }),
	);
}
