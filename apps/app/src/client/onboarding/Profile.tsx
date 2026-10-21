import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Mascot, type MascotMood } from '@caddie/ui/Mascot';
import { useProfile, type ProfileRecord } from '../queries.ts';
import { fetchJson } from '../api.ts';
import { InterestPicker } from '../interests/InterestPicker.tsx';
import { SegmentField } from '../forms/SegmentField.tsx';
import { COUNTRY_OPTIONS } from '../country.ts';
import { OPEN_TO_ANYTHING_INTEREST } from '../interests/catalog.ts';

const names = new Intl.DisplayNames(['en'], { type: 'region' });
const countries = COUNTRY_OPTIONS;

export function OnboardingProfile({ actorId, onDone }: { actorId: string; onDone: () => Promise<void> }) {
 const profile = useProfile({ actorId });
 if (profile.isPending) return <p role="status">Loading your profile…</p>;
 if (profile.error) return <div role="alert"><p>We couldn’t load your profile.</p><button className="btn-ghost" onClick={() => void profile.refetch()}>Try again</button></div>;
 return <ProfileForm initial={profile.data?.profile ?? null} actorId={actorId} onDone={onDone} />;
}

function ProfileForm({ initial, actorId, onDone }: { initial: ProfileRecord | null; actorId: string; onDone: () => Promise<void> }) {
 const cache = useQueryClient();
 const [step, setStep] = useState(0);
 const heading = useRef<HTMLHeadingElement>(null);
 useEffect(() => { heading.current?.focus(); }, [step]);
 const steps = [
  { label: 'About you', title: 'Where are you joining from?', description: 'Find hackathons you can join, with deadlines in your local time.' },
  { label: 'What you’re into', title: 'A few quick picks. Then we’re off.', description: 'Help me tailor what I find and how we build.' },
 ];
 const [country, setCountry] = useState(initial?.country ?? '');
 const [countryQuery, setCountryQuery] = useState(initial?.country ? (names.of(initial.country) ?? '') : '');
 const [timezone, setTimezone] = useState(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
 const [format, setFormat] = useState(initial?.formatPreference ?? '');
 const [experience, setExperience] = useState(initial?.experienceLevel ?? '');
 const [interests, setInterests] = useState<string[]>(initial?.freeTextInterests?.length ? initial.freeTextInterests : [OPEN_TO_ANYTHING_INTEREST]);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const lastStep = steps.length - 1;
 const mood: MascotMood = step === 0 ? 'listening' : 'ready';
 async function save() {
  if (busy) return;
  setBusy(true); setError(null);
  try {
   // Minimal onboarding: only the essentials are set here. Every other field
   // (skills, highlight, tools, budget, hours) is preserved from the existing
   // profile and is captured later in conversation (update_profile / remember)
   // or edited in Settings — onboarding is no longer a wall for them.
   const result = await fetchJson<{ profile: ProfileRecord }>('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    country,
    timezone,
    experienceLevel: experience,
    formatPreference: format === '' ? null : format,
    freeTextInterests: interests,
   }) });
   cache.setQueryData(['profile', actorId], result);
   await onDone();
  } catch (err) { setError(err instanceof Error ? err.message : 'We couldn’t save your profile. Please try again.'); }
  finally { setBusy(false); }
 }
 return <section className={`card-surface onboarding-card${step === lastStep ? ' onboarding-quick-picks' : ''}`} data-testid="onboarding-profile">
  <header className="onboarding-head">
   {step === lastStep ? <button className="btn-ghost onboarding-back" type="button" aria-label="Back" onClick={() => { setError(null); setStep(step - 1); }}>← Back</button> : <span className="onboarding-head-mascot" aria-hidden="true"><Mascot mood={mood} size={44} live /></span>}
   <div className="onboarding-head-progress">
    <p className="onboarding-head-step">Step {step + 1} of {steps.length}{step === lastStep ? ' · almost done' : ''}</p>
    <ol className="onboarding-bar" aria-label="Profile setup progress">{steps.map((item, index) => <li key={item.label} aria-current={step === index ? 'step' : undefined} data-done={index < step} data-current={index === step}><span className="sr-only">{item.label}</span></li>)}</ol>
   </div>
  </header>
  <div className="onboarding-title-row">{step === lastStep ? <span aria-hidden="true"><Mascot mood={mood} size={56} live /></span> : null}<h1 ref={heading} tabIndex={-1} className="onboarding-title">{steps[step]!.title}</h1></div>
  <p className="onboarding-lede">{steps[step]!.description}</p>
  <form onSubmit={event => { event.preventDefault(); if (step < lastStep) { if (step === 0 && !country) { setError('Please choose your country from the list as you type.'); return; } setError(null); setStep(step + 1); } else { if (!experience || !format) { setError('Please choose your experience and how you’d like to take part.'); return; } void save(); } }}>
   <fieldset disabled={busy}>
    {step === 0 ? <>
    <div className="onboarding-fieldgroup">
    <label className="onboarding-field">Where do you live?<input className="input" required list="onboarding-countries" placeholder="Start typing your country" autoComplete="country-name" value={countryQuery} onChange={event => { setCountryQuery(event.target.value); const match = countries.find(c => c.name.toLowerCase() === event.target.value.trim().toLowerCase()); setCountry(match ? match.code : ''); }} /><small>Choose your country to check entry requirements.</small></label>
    <datalist id="onboarding-countries">{countries.map(item => <option key={item.code} value={item.name} />)}</datalist>
    <label className="onboarding-field">Your time zone<input className="input" required list="onboarding-timezones" value={timezone} onChange={event => setTimezone(event.target.value)} /><small>Detected from your device. Change it if needed.</small></label>
    </div>
    <datalist id="onboarding-timezones">{Intl.supportedValuesOf('timeZone').map(zone => <option key={zone} value={zone} />)}</datalist>
    </> : null}
    {step === 1 ? <>
    <SegmentField
     legend="Your building experience"
     testId="onboarding-experience"
     value={experience}
     onChange={(value) => setExperience(value as typeof experience)}
     options={[
      { value: 'beginner', label: 'New to it' },
      { value: 'intermediate', label: 'A few apps' },
      { value: 'senior', label: 'Build often' },
     ]}
    />
    <SegmentField
     legend="How would you like to join?"
     testId="onboarding-format"
     value={format}
     onChange={(value) => setFormat(value as typeof format)}
     options={[
      { value: 'online', label: 'Online' },
      { value: 'in_person', label: 'In person' },
      { value: 'either', label: 'Either' },
     ]}
    />
    <InterestPicker compact legend="What sparks your interest?" optional hint="Pick a topic, or keep your options open." selected={interests} onChange={setInterests} testId="onboarding-interests" />
    </> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    <div className="onboarding-step-actions">
     <button className="btn-key welcome-primary" type="submit" data-testid={step === lastStep ? 'onboarding-profile-save' : 'onboarding-profile-continue'}>{busy ? 'Saving your profile…' : step === lastStep ? 'Finish setup' : 'Continue'}{!busy ? <span aria-hidden="true"> →</span> : null}</button>
    </div>
    {step === lastStep ? <p className="onboarding-quick-note">You can change all of this in Settings.</p> : null}
   </fieldset>
  </form>
 </section>;
}
