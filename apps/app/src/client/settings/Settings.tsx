import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { useSessionActor } from '../queries.ts';
import { Memory } from '../memory/Memory.tsx';
import { AutomationsBody, UsageBody } from '../surface.tsx';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';

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
	const search = useSearch({ strict: false }) as { tab?: string; section?: string };
	const tab = TAB_IDS.includes((search.tab ?? 'profile') as SettingsTab) ? ((search.tab ?? 'profile') as SettingsTab) : 'profile';
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
		<div className="shell-loading shell-page" data-testid="settings-screen">
			<SectionFocus section={search.section} />
			<div className="page-col">
				<div className="settings-stack">
					<SettingsTabs active={tab} />
					{tab === 'profile' ? <ProfileEditor initial={profile.data?.profile ?? null} /> : null}
					{tab === 'interests' ? <InterestsPanel profile={profile.data?.profile ?? null} /> : null}
					{tab === 'tools' ? <StacksPanel stacks={stacks.data!.stacks} /> : null}
					{tab === 'knows' ? <Memory /> : null}
					{tab === 'accounts' ? <IntegrationHealthPanel health={health.data!} /> : null}
					{tab === 'routines' ? <AutomationsBody /> : null}
					{tab === 'spending' ? <UsageBody /> : null}
					{tab === 'appearance' ? <AppearancePanel /> : null}
				</div>
			</div>
		</div>
	);
}

/** The eight settings tabs (v2 §4, HANDOFF §2 route table). */
type SettingsTab = 'profile' | 'interests' | 'tools' | 'knows' | 'accounts' | 'routines' | 'spending' | 'appearance';

const TAB_IDS: readonly SettingsTab[] = ['profile', 'interests', 'tools', 'knows', 'accounts', 'routines', 'spending', 'appearance'];

const TAB_LABELS: Record<SettingsTab, string> = {
	profile: 'You',
	interests: 'Interests',
	tools: 'Build tools',
	knows: 'What Caddie knows',
	accounts: 'Connected accounts',
	routines: 'Routines',
	spending: 'Spending',
	appearance: 'Appearance',
};

function SettingsTabs(props: { active: SettingsTab }): ReactElement {
	const navigate = useNavigate();
	return (
		<nav className="settings-tabs" aria-label="Settings sections" data-testid="settings-tabs">
			{TAB_IDS.map((id) => (
				<button
					key={id}
					type="button"
					className="settings-tab"
					data-testid={`settings-tab-${id}`}
					aria-current={props.active === id ? 'page' : undefined}
					onClick={() => void navigate({ to: '/settings', search: { tab: id } })}
				>
					{TAB_LABELS[id]}
				</button>
			))}
		</nav>
	);
}

/** Appearance (§4): the theme toggle and "Reset Caddie width" — the same
 *  reset the resize handle's double-click performs. */
function AppearancePanel(): ReactElement {
	const { theme, toggleTheme, convWidth } = useWorkspaceChrome();
	return (
		<section className="card-surface settings-panel" data-testid="appearance-panel" id="appearance-panel">
			<p className="kicker" data-tone="action">
				APPEARANCE
			</p>
			<h3 className="state-title">Theme</h3>
			<p className="state-detail">Saved only when you pick one — until then pages follow your device.</p>
			<div className="row-actions">
				<button type="button" className="btn-ghost" data-testid="appearance-theme-toggle" onClick={toggleTheme}>
					{theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
				</button>
			</div>
			<h3 className="state-title">Caddie panel</h3>
			<div className="row-actions">
				<button type="button" className="btn-ghost" data-testid="appearance-reset-width" onClick={convWidth.reset}>
					Reset Caddie width
				</button>
				<span className="state-detail">Back to 40% of the window.</span>
			</div>
		</section>
	);
}

/** Interests (§4 tab list): what Caddie matches hackathons with. Reuses the
 *  real profile PATCH; empty input saves as "nothing recorded". */
function InterestsPanel({ profile }: { profile: ProfileRecord | null }): ReactElement {
	const queryClient = useQueryClient();
	const actor = useSessionActor(true);
	const [freeText, setFreeText] = useState((profile?.freeTextInterests ?? []).join(', '));
	const [stackIds, setStackIds] = useState<string[]>(profile?.stackIds ?? []);
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggleStack = (id: string) =>
		setStackIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

	async function save() {
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			await fetchJson('/api/profile', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					country: profile?.country ?? null,
					timezone: profile?.timezone ?? null,
					weeklyHours: profile?.weeklyHours ?? null,
					experienceLevel: profile?.experienceLevel ?? null,
					stackIds,
					freeTextInterests: freeText
						.split(',')
						.map((entry) => entry.trim())
						.filter((entry) => entry.length > 0)
						.slice(0, MAX_INTERESTS),
				}),
			});
			setSaved(true);
			void queryClient.invalidateQueries({ queryKey: ['profile', actor.data ?? 'pending'] });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="card-surface settings-panel" data-testid="interests-panel" id="interests-panel">
			<p className="kicker" data-tone="action">
				INTERESTS
			</p>
			<h3 className="state-title">What would you enjoy building?</h3>
			<p className="state-detail">
				Free-text interests (comma separated) and the tools you prefer shape what Discover ranks for
				you.
			</p>
			<label className="kicker" htmlFor="interests-free">
				Interests
			</label>
			<input
				id="interests-free"
				className="input"
				data-testid="interests-free"
				placeholder="e.g. developer tools, climate, dashboards"
				value={freeText}
				onChange={(e) => setFreeText(e.target.value)}
			/>
			<p className="kicker">Preferred tools to build with</p>
			<div className="row">
				{CLIENT_STACK_IDS.map((id) => (
					<label key={id} className="check">
						<input type="checkbox" checked={stackIds.includes(id)} onChange={() => toggleStack(id)} data-testid={`interest-stack-${id}`} />
						<span>{id}</span>
					</label>
				))}
			</div>
			{error ? (
				<div role="alert" className="sign-in-error" data-testid="interests-error">
					<b>Could not save.</b>
					<span> {error}</span>
				</div>
			) : null}
			<div className="row-actions">
				<button type="button" className="btn-key" disabled={busy} onClick={() => void save()} data-testid="interests-save">
					{busy ? 'Saving…' : 'Save interests'}
				</button>
				{saved ? <span className="status-pill" data-status="handled" data-testid="interests-saved">saved</span> : null}
			</div>
		</section>
	);
}

/** Audit S33: the account menu lands here with ?section=… — the requested
 *  panel is scrolled into view and focused, not silently ignored. */
function SectionFocus({ section }: { section?: string }): null {
	useEffect(() => {
		if (!section) return;
		const timer = window.setTimeout(() => {
			const el = document.getElementById(section);
			if (!el) return;
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			el.setAttribute('tabindex', '-1');
			(el as HTMLElement).focus({ preventScroll: true });
		}, 150);
		return () => window.clearTimeout(timer);
	}, [section]);
	return null;
}

function SettingsSubnav(): ReactElement {
	const sections = [
		['profile-editor', 'Profile'],
		['integrations-health', 'Integrations'],
		['stacks-panel', 'Build tools'],
		['memory-panel', 'What Caddie knows'],
		['search-panel', 'Search'],
	] as const;
	return (
		<nav className="settings-subnav" aria-label="Settings sections">
			{sections.map(([id, label]) => (
				<a key={id} href={`#${id}`} data-testid={`settings-nav-${id}`}>
					{label}
				</a>
			))}
		</nav>
	);
}

function ProfileEditor({ initial }: { initial: ProfileRecord | null }): ReactElement {
	const queryClient = useQueryClient();
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
					weeklyHours: draft.weeklyHours.trim() === '' ? null : Number(draft.weeklyHours),
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
			// The profile feeds eligibility and discovery — stale verdicts must
			// not outlive a saved change (audit F11).
			void queryClient.invalidateQueries({ queryKey: ['profile'] });
			void queryClient.invalidateQueries({ queryKey: ['brief'] });
			void queryClient.invalidateQueries({ queryKey: ['discovery-candidates'] });
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
		<section className="card-surface settings-panel" data-testid="profile-editor" id="profile-editor">
			<p className="kicker" data-tone="action">
				PROFILE
			</p>
			<h3 className="state-title">Your profile</h3>
			<p className="state-detail">
				All fields are optional — Caddie works without them. These four fields feed every fit verdict on
				every other page.
			</p>
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
					<label key={id} className="pill stack-toggle">
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
			<p className="mono-id" data-testid="profile-interests-count">
				{interestCount} / {MAX_INTERESTS} · each entry capped at {MAX_INTEREST_LENGTH} characters · Save stays
				live and says which one is over
			</p>
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
	const row = (testId: string, title: string, configured: boolean, check: string) => (
		<div className="inspector-row" data-testid={testId}>
			<div className="row-main">
				<span className="row-title">{title}</span>
				<span className="status-pill" data-status={configured ? 'handled' : 'planned'}>
					{configured ? 'configured' : 'not configured'}
				</span>
			</div>
			<div className="row-details">
				{configured ? 'both variables present · callback not exercised — a presence check, not a working sign-in' : check}
			</div>
		</div>
	);
	return (
		<section className="card-surface settings-panel" data-testid="integrations-health" id="integrations-health">
			<p className="kicker" data-tone="action">
				INTEGRATIONS
			</p>
			<h3 className="state-title">Integration health</h3>
			<p className="state-detail">Reported directly from this deployment's configuration — names and pairs, never values.</p>
			<div className="row-list">
				{row('integration-auth-google', 'Google sign-in', health.auth.providers.google, 'missing GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET')}
				{row('integration-auth-github', 'GitHub sign-in', health.auth.providers.github, 'missing GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET')}
				<div className="inspector-row" data-testid="integration-sandbox">
					<div className="row-main">
						<span className="row-title">Build sandbox (agent runs)</span>
						<span className="status-pill" data-status={health.sandbox.configured ? 'handled' : 'planned'}>
							{health.sandbox.configured ? 'configured' : 'not configured'}
						</span>
					</div>
					<div className="row-details">
						{health.sandbox.configured
							? 'both variables present · callback not exercised — a presence check, not a working run'
							: `missing ${health.sandbox.missing.join(', ') || 'variables'} — agent runs fail honestly until these are set`}
					</div>
				</div>
			</div>
		</section>
	);
}

function StacksPanel({ stacks }: { stacks: StacksResponse['stacks'] }): ReactElement {
	return (
		<section className="card-surface settings-panel" data-testid="stacks-panel" id="stacks-panel">
			<p className="kicker" data-tone="action">
				BUILD TOOLS
			</p>
			<h3 className="state-title">Tools to build with</h3>
			<p className="state-detail">
				Each tool opens for building only after it passes its own full live test — the wording here
				never runs ahead of the feature ledger.
			</p>
			<div className="row-list" data-testid="stacks-list">
				{stacks.map((stack) => (
					<div className="inspector-row" key={stack.id} data-testid={`stack-${stack.id}`}>
						<div className="row-main">
							<span className="row-title">{stack.id}</span>
							<span className="status-pill" data-status={stack.status === 'enabled' ? 'handled' : 'planned'}>
								{stack.status === 'enabled' ? 'Being proven first' : 'Later'}
							</span>
						</div>
						{/* B03 (not yet landed): the "Tell me when it's ready" toggle
						    stays hidden until the server can record it — never a fake
						    switch. */}
					</div>
				))}
			</div>
			<p className="state-detail">"Start a project" lists the Later tools greyed out until they pass their live test.</p>
		</section>
	);
}
