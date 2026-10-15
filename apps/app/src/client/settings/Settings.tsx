import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../api.ts';
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
	stackLabel,
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

interface StacksResponse {
	stacks: { id: string; status: 'enabled' | 'planned'; note?: string }[];
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
	const stored = profile.data?.profile ?? null;

	return (
		<div className="shell-loading shell-page" data-testid="settings-screen">
			<SectionFocus section={search.section} />
			<div className="page-col">
				<div className="settings-layout">
					<SettingsRail active={section.id} />
					<div className="settings-content" data-section={section.id}>
						<header className="settings-head">
							<p className="kicker" data-tone="action">Settings</p>
							<h1 className="page-title" data-testid="settings-title">{section.label}</h1>
							<p className="page-lede">{section.lede}</p>
						</header>
						{section.id === 'profile' ? <ProfileSection initial={stored} /> : null}
						{section.id === 'interests' ? <InterestsSection initial={stored} /> : null}
						{section.id === 'tools' ? <ToolsSection stacks={stacks.data!.stacks} /> : null}
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

/** The grouped section rail: a left column on desktop, one scrolling row on mobile. */
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
							{s.label}
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

function ToolsSection({ stacks }: { stacks: StacksResponse['stacks'] }): ReactElement {
	return (
		<section className="settings-section-body" data-testid="stacks-panel" id="stacks-panel">
			<ul className="settings-rows" data-testid="stacks-list">
				{stacks.map((stack) => {
					const label = stackLabel(stack.id);
					const available = stack.status === 'enabled';
					return (
						<li className="settings-row" key={stack.id} data-testid={`stack-${stack.id}`}>
							<div className="settings-row-main">
								<span className="settings-row-title">{label.name}</span>
								<span className="settings-row-detail">
									{label.detail}
									{available ? ' · being proven first' : ''}
								</span>
							</div>
							<span className="status-pill" data-status={available ? 'handled' : 'planned'}>
								{available ? 'Available' : 'Coming later'}
							</span>
						</li>
					);
				})}
			</ul>
		</section>
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
					<span className="settings-row-detail">Back to 40% of the window.</span>
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
