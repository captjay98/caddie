import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { useSessionActor, useSessionEmail } from '../queries.ts';
import { Memory } from '../memory/Memory.tsx';
import { AutomationsBody, UsageBody } from '../surface.tsx';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { ThemePicker } from '../workspace/ThemePicker.tsx';
import { InterestPicker } from '../interests/InterestPicker.tsx';
import { SegmentField } from '../forms/SegmentField.tsx';
import { ChipListField } from '../forms/ChipListField.tsx';
import { COUNTRY_OPTIONS, countryCodeForName, countryName } from '../country.ts';
import {
	HOURS_CHOICES,
	SETTINGS_GROUPS,
	hoursChoiceFor,
	hoursForChoice,
	sectionFor,
	serviceStatus,
	type SettingsTab,
} from './settings-model.ts';

/**
 * Settings: one page header (label + section title + one-line intro) over a
 * grouped section rail — You / Caddie / Account — and plain section bodies
 * (no card inside a card, no repeated section name).
 *
 * Every piece of profile data is edited in exactly ONE place:
 *   - Profile: where you live (searchable), time zone, experience, how you
 *     take part, weekly hours — the same choices onboarding asks;
 *   - Interests: the shared interest picker plus skills;
 *   - Build tools: read-only, plain names.
 * Saves send only the fields of their own section; the server merges, so one
 * section can never overwrite another's data.
 *
 * Honesty rules kept from P14:
 *   - server configuration is reported as it is (names of missing settings,
 *     never values), with no fake "test connection" buttons;
 *   - a stack is "Available" only when the server says it is enabled;
 *   - a failed save keeps the user's draft on screen with the error.
 */

interface ProfileRecord {
	userId: string;
	country: string | null;
	timezone: string | null;
	weeklyHours: number | null;
	experienceLevel: 'beginner' | 'intermediate' | 'senior' | null;
	formatPreference?: 'online' | 'in_person' | 'either' | null;
	stackIds: string[];
	freeTextInterests: string[];
	skills?: string[];
}

interface IntegrationsHealth {
	auth: { providers: { google: boolean; github: boolean } };
	sandbox: { configured: boolean; missing: string[] };
}

const TIME_ZONES: readonly string[] = (() => {
	try {
		return Intl.supportedValuesOf('timeZone');
	} catch {
		return [];
	}
})();

export function Settings(): ReactElement {
	const search = useSearch({ strict: false }) as { tab?: string; section?: string };
	const section = sectionFor(search.tab);
	const navigate = useNavigate();
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

	if (actor.isPending || profile.isPending || health.isPending) {
		return <StatePanel kind="loading" title="Loading your settings…" />;
	}
	const error = actor.error ?? profile.error ?? health.error;
	if (error) {
		return (
			<StatePanel
				kind={failureKind(error)}
				detail={error instanceof Error ? error.message : undefined}
				onRetry={() => void profile.refetch()}
			/>
		);
	}
	const stored = profile.data?.profile ?? null;

	return (
		<div className="shell-loading shell-page" data-testid="settings-screen">
			<SectionFocus section={search.section} />
			<div className="page-col">
				<div className="settings-layout settings-account-layout" data-detail={Boolean(search.tab || search.section)}>
					<header className="settings-mobile-index"><p className="page-lede">Make Caddie work for you.</p></header>
					<SettingsRail active={section.id} />
					<div className="settings-content" data-section={section.id}>
						<button type="button" className="settings-back" data-testid="settings-back" onClick={() => void navigate({ to: '/settings', search: {} })}>← Back to Settings</button>
						<header className="settings-head">
							<p className="kicker" data-tone="action">Settings</p>
							<h1 className="page-title" data-testid="settings-title">{section.label}</h1>
							<p className="page-lede">{section.lede}</p>
						</header>
						{section.id === 'profile' ? <ProfileSection initial={stored} /> : null}
						{section.id === 'interests' ? <InterestsSection initial={stored} /> : null}
						{section.id === 'notifications' ? <NotificationsSection /> : null}
						{section.id === 'knows' ? <Memory embedded /> : null}
						{section.id === 'routines' ? <AutomationsBody /> : null}
						{section.id === 'accounts' ? <AccountsSection health={health.data!} /> : null}
						{section.id === 'spending' ? <UsageBody /> : null}
						{section.id === 'appearance' ? <AppearanceSection /> : null}
					</div>
				</div>
			</div>
		</div>
	);
}

/** The grouped section rail: a left column on desktop, a grouped section list on mobile. */
function SettingsRail({ active }: { active: SettingsTab }): ReactElement {
	const navigate = useNavigate();
	return (
		<nav className="settings-rail" aria-label="Settings sections" data-testid="settings-tabs">
			{SETTINGS_GROUPS.map((group) => (
				<div key={group.label} className="settings-rail-group" role="group" aria-label={group.label}>
					<p className="settings-rail-label" aria-hidden="true">{group.label}</p>
					{group.sections.map((s) => (
						<button
							key={s.id}
							type="button"
							className="settings-tab"
							data-testid={`settings-tab-${s.id}`}
							aria-current={active === s.id ? 'page' : undefined}
							onClick={() => void navigate({ to: '/settings', search: { tab: s.id } })}
						>
							{s.label}<span className="settings-section-chevron" aria-hidden="true">›</span>
						</button>
					))}
				</div>
			))}
		</nav>
	);
}

/** Save row shared by the editable sections: one button, then "Saved" or the error. */
function SaveRow({ busy, saved, error, onSave, testId, disabled }: {
	busy: boolean;
	saved: boolean;
	error: string | null;
	onSave: () => void;
	testId: string;
	disabled?: boolean;
}): ReactElement {
	return (
		<div className="settings-save">
			<button type="button" className="btn-key" disabled={busy || disabled} onClick={onSave} data-testid={`${testId}-save`}>
				{busy ? 'Saving…' : 'Save changes'}
			</button>
			{saved ? (
				<span className="settings-saved" role="status" data-testid={`${testId}-saved`}>
					Saved
				</span>
			) : null}
			{error ? (
				<p className="form-error" role="alert" data-testid={`${testId}-error`}>
					{error}
				</p>
			) : null}
		</div>
	);
}

/** PUT /api/profile with ONLY this section's fields (the server merges), then refresh what depends on it. */
function useProfileSave(): (body: Record<string, unknown>) => Promise<void> {
	const queryClient = useQueryClient();
	return async (body) => {
		await fetchJson('/api/profile', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		// The profile feeds eligibility and discovery — stale verdicts must not
		// outlive a saved change (audit F11).
		void queryClient.invalidateQueries({ queryKey: ['profile'] });
		void queryClient.invalidateQueries({ queryKey: ['brief'] });
		void queryClient.invalidateQueries({ queryKey: ['discovery-candidates'] });
	};
}

function ProfileSection({ initial }: { initial: ProfileRecord | null }): ReactElement {
	const saveProfile = useProfileSave();
	// Draft state, owned locally: a failed save never wipes the user's input.
	const [countryQuery, setCountryQuery] = useState(countryName(initial?.country) ?? '');
	const [timezone, setTimezone] = useState(initial?.timezone ?? '');
	const [experience, setExperience] = useState<string>(initial?.experienceLevel ?? '');
	const [format, setFormat] = useState<string>(initial?.formatPreference ?? '');
	const [hours, setHours] = useState(hoursChoiceFor(initial?.weeklyHours));
	// The stored number is only replaced when the user picks a range, so an
	// exact value (e.g. 12) survives a save that didn't touch hours.
	const [hoursTouched, setHoursTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setSaved(false);
		setError(null);
		const typed = countryQuery.trim();
		const code = typed ? countryCodeForName(typed) : null;
		if (typed && !code) {
			setError('Choose your country from the list as you type.');
			return;
		}
		setBusy(true);
		try {
			await saveProfile({
				country: code,
				timezone: timezone.trim() || null,
				experienceLevel: experience || null,
				formatPreference: format || null,
				...(hoursTouched ? { weeklyHours: hoursForChoice(hours) } : {}),
			});
			setSaved(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Saving your profile failed.');
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="settings-section-body" data-testid="profile-editor" id="profile-editor">
			<div className="settings-fields-2">
				<label className="settings-field">
					<span className="settings-field-label">Where you live</span>
					<input
						className="input"
						list="settings-countries"
						placeholder="Start typing your country"
						data-testid="profile-country"
						value={countryQuery}
						onChange={(event) => setCountryQuery(event.target.value)}
					/>
					<small>Some hackathons only accept entrants from certain countries.</small>
				</label>
				<datalist id="settings-countries">
					{COUNTRY_OPTIONS.map((c) => (
						<option key={c.code} value={c.name} />
					))}
				</datalist>
				<label className="settings-field">
					<span className="settings-field-label">Time zone</span>
					<input
						className="input"
						list="settings-timezones"
						placeholder="Start typing a city"
						data-testid="profile-timezone"
						value={timezone}
						onChange={(event) => setTimezone(event.target.value)}
					/>
					<small>Deadlines show in this time zone.</small>
				</label>
				<datalist id="settings-timezones">
					{TIME_ZONES.map((zone) => (
						<option key={zone} value={zone} />
					))}
				</datalist>
			</div>
			<SegmentField
				legend="How much have you built before?"
				testId="profile-experience"
				value={experience}
				onChange={setExperience}
				options={[
					{ value: 'beginner', label: 'New to it', icon: 'sparkCheck' },
					{ value: 'intermediate', label: 'A few apps', icon: 'box' },
					{ value: 'senior', label: 'Experienced', icon: 'target' },
				]}
			/>
			<SegmentField
				legend="How do you want to take part?"
				testId="profile-format"
				value={format}
				onChange={setFormat}
				options={[
					{ value: 'online', label: 'Online' },
					{ value: 'in_person', label: 'In person' },
					{ value: 'either', label: 'Either' },
				]}
			/>
			<SegmentField
				legend="Hours a week you can give"
				testId="profile-weekly-hours"
				value={hours}
				onChange={(value) => {
					setHours(value);
					setHoursTouched(true);
				}}
				options={HOURS_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
			/>
			<SaveRow busy={busy} saved={saved} error={error} onSave={() => void save()} testId="profile" />
		</section>
	);
}

function InterestsSection({ initial }: { initial: ProfileRecord | null }): ReactElement {
	const saveProfile = useProfileSave();
	const [interests, setInterests] = useState<string[]>(initial?.freeTextInterests ?? []);
	const [skills, setSkills] = useState<string[]>(initial?.skills ?? []);
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setBusy(true);
		setSaved(false);
		setError(null);
		try {
			await saveProfile({ freeTextInterests: interests, skills });
			setSaved(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Saving your interests failed.');
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="settings-section-body" data-testid="interests-panel" id="interests-panel">
			<InterestPicker selected={interests} onChange={setInterests} testId="interests-picker" hint="Pick any — or leave it and tell Caddie as you go." />
			<ChipListField
				legend="Your skills"
				hint="Caddie also learns these from chat and your GitHub — remove any that are wrong."
				values={skills}
				onChange={setSkills}
				testId="skills-field"
				placeholder="+ Add a skill"
			/>
			<SaveRow busy={busy} saved={saved} error={error} onSave={() => void save()} testId="interests" />
		</section>
	);
}

/** Plain-language names for the notification kinds a person can tune. */
const NOTIFICATION_KIND_LABELS: Record<string, { title: string; detail: string }> = {
	build_paused: { title: 'A build needs your attention', detail: 'Caddie paused a build and needs you to look.' },
	task_reminder: { title: 'A task is due', detail: 'A reminder for something on your to-do list.' },
	sentinel_material_change: { title: 'Something changed on a watch', detail: 'A page or source Caddie watches for you has changed.' },
	discovery_fit: { title: 'A good hackathon match', detail: 'Caddie found a hackathon that fits what you build.' },
	schedule_fired: { title: 'A routine ran', detail: 'One of your scheduled checks has run.' },
	stack_enabled: { title: 'A new build tool is ready', detail: 'A new way to build became available.' },
};

interface NotificationPrefRow {
	kind: string;
	email: boolean;
	push: boolean;
	isDefault: boolean;
}

function NotificationsSection(): ReactElement {
	const queryClient = useQueryClient();
	const prefs = useQuery({
		queryKey: ['notification-prefs'],
		queryFn: () => fetchJson<{ prefs: NotificationPrefRow[] }>('/api/notifications/prefs'),
	});
	const setPref = useMutation({
		mutationFn: (body: { kind: string; email: boolean; push: boolean }) =>
			postJson<{ pref: NotificationPrefRow }>('/api/notifications/prefs', body),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notification-prefs'] }),
	});

	if (prefs.isPending) return <StatePanel kind="loading" title="Loading your notification settings…" />;
	if (prefs.error)
		return <StatePanel kind={failureKind(prefs.error)} detail={prefs.error instanceof Error ? prefs.error.message : undefined} onRetry={() => void prefs.refetch()} />;

	const rows = prefs.data?.prefs ?? [];
	const toggle = (row: NotificationPrefRow, channel: 'email' | 'push') =>
		setPref.mutate({ kind: row.kind, email: channel === 'email' ? !row.email : row.email, push: channel === 'push' ? !row.push : row.push });

	return (
		<section className="settings-section-body" data-testid="notifications-panel" id="notifications-panel">
			<p className="settings-row-detail" style={{ marginBottom: '12px' }}>
				Caddie always keeps these in your inbox here. Turn on email or push to also hear about them when you’re away.
			</p>
			<PushEnable />
			<ul className="settings-rows" data-testid="notification-prefs-list">
				{rows.map((row) => {
					const label = NOTIFICATION_KIND_LABELS[row.kind] ?? { title: row.kind, detail: '' };
					return (
						<li className="settings-row" key={row.kind} data-testid={`notif-pref-${row.kind}`}>
							<div className="settings-row-main">
								<span className="settings-row-title">{label.title}</span>
								<span className="settings-row-detail">{label.detail}</span>
							</div>
							<div className="notif-pref-toggles" role="group" aria-label={`How to be told about: ${label.title}`}>
								<label className="notif-pref-toggle">
									<input
										type="checkbox"
										checked={row.email}
										disabled={setPref.isPending}
										data-testid={`notif-pref-${row.kind}-email`}
										onChange={() => toggle(row, 'email')}
									/>
									Email
								</label>
								<label className="notif-pref-toggle">
									<input
										type="checkbox"
										checked={row.push}
										disabled={setPref.isPending}
										data-testid={`notif-pref-${row.kind}-push`}
										onChange={() => toggle(row, 'push')}
									/>
									Push
								</label>
							</div>
						</li>
					);
				})}
			</ul>
			{setPref.error ? <p className="state-detail" role="alert">Couldn’t save that change. Try again.</p> : null}
		</section>
	);
}

/** base64url VAPID public key → the Uint8Array pushManager.subscribe wants. */
function vapidKeyToBytes(b64url: string): Uint8Array {
	const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
	const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(b64);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

/**
 * Turn web push on/off for THIS browser. Push needs: a service worker (we have
 * one), the server's VAPID public key, and the person's permission. The button
 * reflects the real state and says plainly when the browser or the server does
 * not support it, rather than failing silently.
 */
function PushEnable(): ReactElement {
	const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
	const [state, setState] = useState<'unknown' | 'on' | 'off' | 'denied' | 'unavailable' | 'busy'>('unknown');
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!supported) return setState('unavailable');
		if (Notification.permission === 'denied') return setState('denied');
		(async () => {
			const reg = await navigator.serviceWorker.getRegistration();
			const sub = await reg?.pushManager.getSubscription();
			setState(sub ? 'on' : 'off');
		})().catch(() => setState('off'));
	}, [supported]);

	async function enable() {
		setError(null);
		setState('busy');
		try {
			const { publicKey } = await fetchJson<{ publicKey: string | null }>('/api/notifications/vapid');
			if (!publicKey) {
				setState('unavailable');
				setError('Push isn’t set up on this server yet.');
				return;
			}
			const permission = await Notification.requestPermission();
			if (permission !== 'granted') {
				setState(permission === 'denied' ? 'denied' : 'off');
				return;
			}
			const reg = (await navigator.serviceWorker.getRegistration('/app/')) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/app/' }));
			// pushManager.subscribe throws "no active Service Worker" unless the
			// worker has finished activating — a fresh registration (dev
			// deliberately unregisters at startup) is still installing here.
			if (!reg.active) {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('The notification worker did not activate. Reload the page and try again.')), 10_000);
					const settle = () => { clearTimeout(timer); resolve(); };
					void navigator.serviceWorker.ready.then(settle, reject);
					const worker = reg.waiting ?? reg.installing;
					if (worker) worker.addEventListener('statechange', () => { if (worker.state === 'activated') settle(); }, { once: true });
				});
			}
			const sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: vapidKeyToBytes(publicKey) as BufferSource,
			});
			const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
			await postJson('/api/notifications/push/subscribe', { subscription: json });
			setState('on');
		} catch (cause) {
			setState('off');
			setError(cause instanceof Error ? cause.message : 'Could not turn on push.');
		}
	}

	async function disable() {
		setError(null);
		setState('busy');
		try {
			const reg = await navigator.serviceWorker.getRegistration();
			const sub = await reg?.pushManager.getSubscription();
			if (sub) {
				await postJson('/api/notifications/push/unsubscribe', { endpoint: sub.endpoint });
				await sub.unsubscribe();
			}
			setState('off');
		} catch (cause) {
			setState('on');
			setError(cause instanceof Error ? cause.message : 'Could not turn off push.');
		}
	}

	return (
		<div className="notif-push-enable" data-testid="push-enable" data-state={state}>
			<div className="settings-row-main">
				<span className="settings-row-title">Push on this device</span>
				<span className="settings-row-detail">
					{state === 'unavailable'
						? 'This browser or server doesn’t support push.'
						: state === 'denied'
							? 'Blocked in your browser settings — allow notifications for this site to use push.'
							: state === 'on'
								? 'Push is on for this browser. Turn on Push for a kind below to get it.'
								: 'Get a push notification in this browser when something needs you.'}
				</span>
			</div>
			{state === 'on' ? (
				<button type="button" className="btn-ghost" data-testid="push-disable-btn" onClick={() => void disable()}>
					Turn off
				</button>
			) : (
				<button
					type="button"
					className="btn-key"
					data-testid="push-enable-btn"
					disabled={state === 'busy' || state === 'unavailable' || state === 'denied'}
					onClick={() => void enable()}
				>
					{state === 'busy' ? 'Turning on…' : 'Turn on push'}
				</button>
			)}
			{error ? <p className="state-detail" role="alert" style={{ flexBasis: '100%' }}>{error}</p> : null}
		</div>
	);
}

interface LinkedAccount {
	providerId: string;
}

function AccountsSection({ health }: { health: IntegrationsHealth }): ReactElement {
	const email = useSessionEmail().data ?? null;
	// Better Auth's own account list: which sign-in providers THIS user has
	// linked. Fail-soft — if it can't be read, no provider is claimed.
	const accounts = useQuery({
		queryKey: ['auth', 'accounts'],
		queryFn: () => fetchJson<LinkedAccount[]>('/api/auth/list-accounts'),
		retry: false,
	});
	const linked = new Set((Array.isArray(accounts.data) ? accounts.data : []).map((a) => a.providerId));
	const status = serviceStatus(health);
	const provider = (id: 'google' | 'github', name: string) => {
		const configured = health.auth.providers[id];
		const isLinked = linked.has(id);
		const detail = isLinked
			? email
				? `Signed in as ${email}`
				: 'Linked to your account'
			: !configured
				? 'Not offered on this server'
				: accounts.isError
					? 'Couldn’t check right now'
					: 'Not linked';
		return (
			<li className="settings-row" data-testid={`account-${id}`}>
				<div className="settings-row-main">
					<span className="settings-row-title">{name}</span>
					<span className="settings-row-detail">{detail}</span>
				</div>
				{isLinked ? <span className="status-pill" data-status="handled">Connected</span> : null}
			</li>
		);
	};

	return (
		<section className="settings-section-body" id="integrations-health-section">
			<ul className="settings-rows">
				{provider('google', 'Google')}
				{provider('github', 'GitHub sign-in')}
				<li className="settings-row" data-testid="account-github-repos">
					<div className="settings-row-main">
						<span className="settings-row-title">GitHub repositories</span>
						<span className="settings-row-detail">Connect a repository from a project’s settings — Caddie only reaches the repos you pick.</span>
					</div>
				</li>
				<li className="settings-row settings-row-stack" data-testid="service-status">
					<div className="settings-row-main">
						<span className="settings-row-title">Service status</span>
						<span className="settings-row-detail">{status.summary}</span>
					</div>
					<span className="status-pill" data-status={status.ok ? 'handled' : 'planned'}>
						{status.ok ? 'All good' : 'Needs setup'}
					</span>
				</li>
			</ul>
			<details className="settings-details" open={!status.ok}>
				<summary>Details for whoever runs this server</summary>
				{/* Reported directly from this deployment's configuration — names, never values. */}
				<div className="settings-rows" data-testid="integrations-health" id="integrations-health">
					<HealthRow testId="integration-auth-google" title="Google sign-in" configured={health.auth.providers.google} missing="GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET" />
					<HealthRow testId="integration-auth-github" title="GitHub sign-in" configured={health.auth.providers.github} missing="GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET" />
					<HealthRow
						testId="integration-sandbox"
						title="Build sandbox"
						configured={health.sandbox.configured}
						missing={health.sandbox.missing.join(', ') || 'sandbox variables'}
					/>
				</div>
			</details>
		</section>
	);
}

function HealthRow({ testId, title, configured, missing }: { testId: string; title: string; configured: boolean; missing: string }): ReactElement {
	return (
		<div className="settings-row" data-testid={testId}>
			<div className="settings-row-main">
				<span className="settings-row-title">{title}</span>
				<span className="settings-row-detail">{configured ? 'Settings present (not a live sign-in test)' : `Missing ${missing}`}</span>
			</div>
			<span className="status-pill" data-status={configured ? 'handled' : 'planned'}>
				{configured ? 'configured' : 'not configured'}
			</span>
		</div>
	);
}

/** Appearance: the theme picker and "Reset Caddie width" — the same reset the resize handle's double-click performs. */
function AppearanceSection(): ReactElement {
	const { theme, palette, setThemeChoice, convWidth } = useWorkspaceChrome();
	return (
		<section className="settings-section-body" data-testid="appearance-panel" id="appearance-panel">
			<ThemePicker variant="panel" palette={palette} mode={theme} onChange={setThemeChoice} />
			<div className="settings-group">
				<h2 className="settings-subhead">Caddie panel</h2>
				<div className="settings-save">
					<button type="button" className="btn-ghost" data-testid="appearance-reset-width" onClick={convWidth.reset}>
						Reset Caddie width
					</button>
					<span className="settings-row-detail">Back to half the window.</span>
				</div>
			</div>
		</section>
	);
}

/** Audit S33: links can land here with ?section=… — the requested part is scrolled into view and focused. */
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
