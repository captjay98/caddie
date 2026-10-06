import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { useSessionActor } from '../queries.ts';
import { Memory } from '../memory/Memory.tsx';
import { Search } from '../search/Search.tsx';

/**
 * P14 settings UI: profile editing, honest integration health, enabled
 * stacks, plus the memory and search panels.
 *
 * Honesty rules:
 *   - Integration health reports what the server actually sees (presence of
 *     provider/sandbox configuration) — no fake "test connection" buttons and
 *     no secret values.
 *   - The stack list reflects reality: react-hono is enabled (proving);
 *     everything else is visibly planned, not quietly implied as available.
 *   - A failed save keeps the user's draft on screen with the error — an
 *     interrupted save never wipes their input.
 */

interface ProfileRecord {
	userId: string;
	country: string | null;
	timezone: string | null;
	weeklyHours: number | null;
	experienceLevel: 'beginner' | 'intermediate' | 'senior' | null;
	stackIds: string[];
	freeTextInterests: string[];
}

interface IntegrationsHealth {
	auth: { providers: { google: boolean; github: boolean } };
	sandbox: { configured: boolean; missing: string[] };
}

interface StacksResponse {
	stacks: { id: string; status: 'enabled' | 'planned'; note?: string }[];
}

const MAX_INTERESTS = 12;
const MAX_INTEREST_LENGTH = 60;

// The five supported stack ids — mirrors the frozen `StackId` union in
// @caddie/contracts (kept local so client bundles never pull the contracts
// module, which is server-oriented). The server rejects anything else.
const CLIENT_STACK_IDS = [
	'react-hono',
	'tanstack-start',
	'laravel-inertia',
	'fastapi-react',
	'flutter',
] as const;

export function Settings(): ReactElement {
	const actor = useSessionActor(true);
	const profile = useQuery({
		queryKey: ['profile', actor.data ?? 'pending'],
		queryFn: () => fetchJson<{ profile: ProfileRecord | null }>('/api/profile'),
		enabled: actor.data != null,
	});
	const health = useQuery({
		queryKey: ['integrations-health'],
		queryFn: () => fetchJson<IntegrationsHealth>('/api/integrations/health'),
		enabled: actor.data != null,
	});
	const stacks = useQuery({
		queryKey: ['stacks'],
		queryFn: () => fetchJson<StacksResponse>('/api/stacks'),
		enabled: actor.data != null,
	});

	if (actor.isPending || profile.isPending || health.isPending || stacks.isPending) {
		return <StatePanel kind="loading" title="Loading your settings…" />;
	}
	const error = actor.error ?? profile.error ?? health.error ?? stacks.error;
	if (error) {
		return (
			<StatePanel
				kind={failureKind(error)}
				detail={error instanceof Error ? error.message : undefined}
				onRetry={() => void profile.refetch()}
			/>
		);
	}

	return (
		<main className="shell-loading" id="main" data-testid="settings-screen">
			<p className="kicker" data-tone="action">
				CADDIE · SETTINGS
			</p>
			<h1 className="state-title">Settings</h1>
			<ProfileEditor initial={profile.data?.profile ?? null} />
			<IntegrationHealthPanel health={health.data!} />
			<StacksPanel stacks={stacks.data!.stacks} />
			<Memory />
			<Search />
		</main>
	);
}

function ProfileEditor({ initial }: { initial: ProfileRecord | null }): ReactElement {
	// Draft state: seeded from the server profile once, then owned locally so
	// a failed save never wipes the user's input.
	const [draft, setDraft] = useState(() => ({
		country: initial?.country ?? '',
		timezone: initial?.timezone ?? '',
		weeklyHours: initial?.weeklyHours == null ? '' : String(initial.weeklyHours),
		experienceLevel: initial?.experienceLevel ?? '',
		stackIds: new Set<string>(initial?.stackIds ?? []),
		interests: (initial?.freeTextInterests ?? []).join(', '),
	}));
	const [ready, setReady] = useState(initial !== null);
	const [saving, setSaving] = useState(false);
	const [savedNote, setSavedNote] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	useEffect(() => {
		if (initial && !ready) {
			setDraft({
				country: initial.country ?? '',
				timezone: initial.timezone ?? '',
				weeklyHours: initial.weeklyHours == null ? '' : String(initial.weeklyHours),
				experienceLevel: initial.experienceLevel ?? '',
				stackIds: new Set<string>(initial.stackIds),
				interests: initial.freeTextInterests.join(', '),
			});
			setReady(true);
		}
	}, [initial, ready]);

	async function save() {
		setSaving(true);
		setSavedNote(false);
		setSaveError(null);
		const interests = draft.interests
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		try {
			await fetch('/api/profile', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					...(draft.country.trim() ? { country: draft.country.trim().toUpperCase() } : { country: null }),
					...(draft.timezone.trim() ? { timezone: draft.timezone.trim() } : { timezone: null }),
					...(draft.weeklyHours.trim() === '' ? {} : { weeklyHours: Number(draft.weeklyHours) }),
					...(draft.experienceLevel === '' ? { experienceLevel: null } : { experienceLevel: draft.experienceLevel }),
					stackIds: [...draft.stackIds],
					freeTextInterests: interests,
				}),
			}).then(async (res) => {
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { message?: string } | null;
					throw new Error(body?.message ?? 'Saving the profile failed.');
				}
			});
			setSavedNote(true);
		} catch (err) {
			// The draft is preserved: fields above are NOT reset on failure.
			setSaveError(err instanceof Error ? err.message : 'Saving the profile failed.');
		} finally {
			setSaving(false);
		}
	}

	const interestCount = draft.interests.split(',').filter((p) => p.trim() !== '').length;

	return (
		<section className="card-surface" data-testid="profile-editor">
			<p className="kicker" data-tone="action">
				PROFILE
			</p>
			<h3 className="state-title">Your profile</h3>
			<p className="state-detail">All fields are optional — Caddie works without them.</p>
			<div className="row">
				<input
					className="input"
					placeholder="Country (2-letter, e.g. CL)"
					aria-label="Country"
					data-testid="profile-country"
					value={draft.country}
					onChange={(event) => setDraft((d) => ({ ...d, country: event.target.value }))}
				/>
				<input
					className="input"
					placeholder="Time zone (IANA, e.g. Europe/Paris)"
					aria-label="Time zone"
					data-testid="profile-timezone"
					value={draft.timezone}
					onChange={(event) => setDraft((d) => ({ ...d, timezone: event.target.value }))}
				/>
			</div>
			<div className="row">
				<input
					className="input"
					placeholder="Weekly hours (0–80)"
					aria-label="Weekly hours"
					type="number"
					min={0}
					max={80}
					data-testid="profile-weekly-hours"
					value={draft.weeklyHours}
					onChange={(event) => setDraft((d) => ({ ...d, weeklyHours: event.target.value }))}
				/>
				<select
					className="input"
					aria-label="Experience level"
					data-testid="profile-experience"
					value={draft.experienceLevel}
					onChange={(event) => setDraft((d) => ({ ...d, experienceLevel: event.target.value }))}
				>
					<option value="">Not set</option>
					<option value="beginner">Beginner</option>
					<option value="intermediate">Intermediate</option>
					<option value="senior">Senior</option>
				</select>
			</div>
			<p className="kicker">STACK INTERESTS (SUPPORTED STACKS)</p>
			<div className="row" data-testid="profile-stacks">
				{CLIENT_STACK_IDS.map((id) => (
					<label key={id} className="pill">
						<input
							type="checkbox"
							data-testid={`profile-stack-${id}`}
							checked={draft.stackIds.has(id)}
							onChange={(event) =>
								setDraft((d) => {
									const next = new Set(d.stackIds);
									if (event.target.checked) next.add(id);
									else next.delete(id);
									return { ...d, stackIds: next };
								})
							}
						/>{' '}
						{id}
					</label>
				))}
			</div>
			<p className="kicker">OTHER INTERESTS (FREE TEXT)</p>
			<input
				className="input"
				placeholder="Comma-separated free text, e.g. Rust, race telemetry"
				aria-label="Free text interests"
				data-testid="profile-interests"
				value={draft.interests}
				onChange={(event) => setDraft((d) => ({ ...d, interests: event.target.value }))}
			/>
			{interestCount > MAX_INTERESTS ? (
				<p className="form-error" role="alert" data-testid="profile-interests-limit">
					At most {MAX_INTERESTS} interests ({MAX_INTEREST_LENGTH} characters each).
				</p>
			) : null}
			<div className="row">
				<button
					type="button"
					className="btn-key"
					data-testid="profile-save"
					disabled={saving || interestCount > MAX_INTERESTS}
					onClick={() => void save()}
				>
					{saving ? 'Saving…' : 'Save profile'}
				</button>
				{savedNote ? (
					<span className="status-pill" data-status="handled" data-testid="profile-saved">
						saved
					</span>
				) : null}
			</div>
			{saveError ? (
				<p className="form-error" role="alert" data-testid="profile-error">
					{saveError}
				</p>
			) : null}
		</section>
	);
}

function IntegrationHealthPanel({ health }: { health: IntegrationsHealth }): ReactElement {
	return (
		<section className="card-surface" data-testid="integrations-health">
			<p className="kicker" data-tone="action">
				INTEGRATIONS
			</p>
			<h3 className="state-title">Integration health</h3>
			<p className="state-detail">Reported directly from this deployment's configuration.</p>
			<div className="row-list">
				<div className="inspector-row" data-testid="integration-auth-google">
					<div className="row-main">
						<span className="row-title">Google sign-in</span>
						<span className="status-pill" data-status={health.auth.providers.google ? 'handled' : 'blocked'}>
							{health.auth.providers.google ? 'configured' : 'not configured'}
						</span>
					</div>
				</div>
				<div className="inspector-row" data-testid="integration-auth-github">
					<div className="row-main">
						<span className="row-title">GitHub sign-in</span>
						<span className="status-pill" data-status={health.auth.providers.github ? 'handled' : 'blocked'}>
							{health.auth.providers.github ? 'configured' : 'not configured'}
						</span>
					</div>
				</div>
				<div className="inspector-row" data-testid="integration-sandbox">
					<div className="row-main">
						<span className="row-title">Build sandbox (agent runs)</span>
						<span className="status-pill" data-status={health.sandbox.configured ? 'handled' : 'blocked'}>
							{health.sandbox.configured ? 'configured' : 'not configured'}
						</span>
					</div>
					{!health.sandbox.configured ? (
						<div className="row-details">
							Agent runs fail honestly until these variables are set: {health.sandbox.missing.join(', ')}
						</div>
					) : null}
				</div>
			</div>
		</section>
	);
}

function StacksPanel({ stacks }: { stacks: StacksResponse['stacks'] }): ReactElement {
	return (
		<section className="card-surface" data-testid="stacks-panel">
			<p className="kicker" data-tone="action">
				OUTPUT STACKS
			</p>
			<h3 className="state-title">Enabled stacks</h3>
			<p className="state-detail">Only stacks that really work today are listed as enabled.</p>
			<div className="row-list" data-testid="stacks-list">
				{stacks.map((stack) => (
					<div className="inspector-row" key={stack.id} data-testid={`stack-${stack.id}`}>
						<div className="row-main">
							<span className="row-title">{stack.id}</span>
							<span className="status-pill" data-status={stack.status === 'enabled' ? 'handled' : 'blocked'}>
								{stack.status}
								{stack.note ? ` · ${stack.note}` : ''}
							</span>
						</div>
					</div>
				))}
			</div>
		</section>
	);
}
